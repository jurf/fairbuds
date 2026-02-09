// Fairbuds Web Bluetooth — QXW Protocol Implementation
// Based on PROTOCOL.md

(function () {
  "use strict";

  // =========================================================================
  // Protocol Constants
  // =========================================================================

  const SERVICE_UUID = "0000ff12-0000-1000-8000-00805f9b34fb";
  const NOTIFY_UUID = "0000ff13-0000-1000-8000-00805f9b34fb";
  const WRITE_UUID = "0000ff14-0000-1000-8000-00805f9b34fb";

  const QXW_PREFIX = [0x51, 0x58, 0x57]; // "QXW"

  const CMD_SELECT_EQ = 0x10;
  const CMD_CUSTOM_EQ = 0x20;
  const CMD_DEVICE_INFO = 0x27;

  const TYPE_REQUEST = 0x01;
  const TYPE_NOTIFY = 0x03;

  const GAIN_OFFSET = 120;
  const GAIN_SCALE = 10;
  const GAIN_MIN_DB = -12.0;
  const GAIN_MAX_DB = 13.5;
  const DEFAULT_Q = 7; // Q = 0.7

  const FREQUENCIES = [60, 100, 230, 500, 1100, 2400, 5400, 12000];
  const NUM_BANDS = FREQUENCIES.length;

  const POST_COMMAND_DELAY = 300;
  const RESPONSE_TIMEOUT = 5000;

  // =========================================================================
  // Custom Presets (from presets/ and presets_app/ directories — AutoEQ format)
  // Each entry: { name, bands: [[gain_db, q_real], ...] (8 bands) }
  // =========================================================================

  // Full EQ presets (variable Q — requires custom protocol support)
  const CUSTOM_PRESETS = [
    { name: "rtings_treble", recommended: true, bands: [[-2.3, 0.10], [4.6, 5.32], [6.4, 0.10], [3.6, 24.95], [-11.0, 0.10], [1.8, 17.00], [-9.1, 1.70], [13.5, 0.10]] },
    { name: "rtings_bass", bands: [[10.0, 0.80], [5.4, 1.77], [-10.0, 0.17], [5.7, 20.22], [3.8, 0.19], [-0.7, 17.99], [-9.8, 1.45], [4.8, 0.11]] },
    { name: "dhrme", bands: [[-2.8, 0.17], [0.0, 7.38], [2.6, 0.17], [-8.8, 0.19], [0.1, 8.94], [8.1, 0.74], [-3.1, 1.73], [6.9, 0.63]] },
    { name: "dhrme_anc", bands: [[4.0, 1.33], [1.9, 4.74], [2.7, 0.27], [-9.2, 0.11], [-1.6, 23.97], [13.4, 0.87], [0.6, 12.00], [7.9, 2.22]] },
    { name: "main-ish", bands: [[-1.0, 0.71], [1.0, 0.71], [2.0, 0.71], [3.5, 0.71], [1.0, 0.71], [-3.0, 0.71], [1.0, 0.71], [1.0, 0.71]] },
  ];

  // App-compatible presets (fixed Q = 0.71 — works with the official Fairbuds app)
  const APP_PRESETS = [
    { name: "rtings", bands: [[4.5, 0.71], [1.8, 0.71], [-10.0, 0.71], [0.8, 0.71], [-7.4, 0.71], [10.0, 0.71], [-8.7, 0.71], [6.6, 0.71]] },
    { name: "dhrme", bands: [[-0.9, 0.71], [-0.9, 0.71], [-5.0, 0.71], [-1.6, 0.71], [-4.3, 0.71], [7.8, 0.71], [-2.6, 0.71], [9.5, 0.71]] },
    { name: "dhrme_anc", bands: [[-2.5, 0.71], [0.3, 0.71], [-7.3, 0.71], [-1.4, 0.71], [-8.8, 0.71], [9.8, 0.71], [-4.7, 0.71], [1.0, 0.71]] },
    { name: "senorbackdoor", bands: [[8.0, 0.7], [-2.0, 0.7], [-5.0, 0.7], [2.0, 0.7], [-2.0, 0.7], [8.0, 0.7], [1.0, 0.7], [11.0, 0.7]] },
  ];

  // =========================================================================
  // State
  // =========================================================================

  let device = null;
  let server = null;
  let writeChar = null;
  let notifyChar = null;
  let connected = false;

  // Current EQ band gains (encoded byte values), default flat (120 = 0 dB)
  const bandGains = new Array(NUM_BANDS).fill(GAIN_OFFSET);
  const bandQs = new Array(NUM_BANDS).fill(DEFAULT_Q);

  // =========================================================================
  // Helpers
  // =========================================================================

  function encodeGain(db) {
    const encoded = Math.round(db * GAIN_SCALE) + GAIN_OFFSET;

    return Math.max(0, Math.min(255, encoded));
  }

  function decodeGain(byteVal) {
    return (byteVal - GAIN_OFFSET) / GAIN_SCALE;
  }

  function formatFreq(hz) {
    return hz >= 1000 ? hz / 1000 + "k" : hz + "";
  }

  function hexStr(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // =========================================================================
  // Logging
  // =========================================================================

  const logEl = document.getElementById("log");

  function log(msg) {
    const ts = new Date().toLocaleTimeString();
    logEl.textContent += `[${ts}] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
    console.log("[Fairbuds]", msg);
  }

  // =========================================================================
  // QXW Packet Builder
  // =========================================================================

  function buildPacket(cmd, type, payload) {
    const pLen = payload ? payload.length : 0;
    const buf = new Uint8Array(3 + 1 + 1 + 1 + pLen);
    buf[0] = QXW_PREFIX[0];
    buf[1] = QXW_PREFIX[1];
    buf[2] = QXW_PREFIX[2];
    buf[3] = cmd;
    buf[4] = type;
    buf[5] = pLen;
    if (payload) {
      buf.set(payload, 6);
    }

    return buf;
  }

  // =========================================================================
  // Send Command
  // =========================================================================

  async function sendCommand(data) {
    if (!writeChar) {
      log("Error: not connected");

      return;
    }
    log("TX → " + hexStr(data));
    await writeChar.writeValueWithoutResponse(data);
    await delay(POST_COMMAND_DELAY);
  }

  // =========================================================================
  // Commands
  // =========================================================================

  async function requestDeviceInfo() {
    const pkt = buildPacket(CMD_DEVICE_INFO, TYPE_REQUEST, null);
    await sendCommand(pkt);
  }

  async function selectPreset(presetNum) {
    const pkt = buildPacket(
      CMD_SELECT_EQ,
      TYPE_REQUEST,
      new Uint8Array([presetNum])
    );
    await sendCommand(pkt);
    log(`Preset ${presetNum} selected`);
  }

  async function sendCustomEQ() {
    const payload = new Uint8Array(NUM_BANDS * 3);
    for (let i = 0; i < NUM_BANDS; i++) {
      payload[i * 3] = i;
      payload[i * 3 + 1] = bandGains[i];
      payload[i * 3 + 2] = bandQs[i];
    }
    const pkt = buildPacket(CMD_CUSTOM_EQ, TYPE_NOTIFY, payload);
    await sendCommand(pkt);
    log("Custom EQ applied");
  }

  async function applyCustomPreset(preset) {
    for (let i = 0; i < NUM_BANDS; i++) {
      const [gainDb, qReal] = preset.bands[i];
      // Clamp gain to valid range
      const clampedGain = Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, gainDb));
      bandGains[i] = encodeGain(clampedGain);
      // Convert Q to byte (Q_byte = Q_real * 10)
      bandQs[i] = Math.max(0, Math.min(255, Math.round(qReal * 10)));
    }
    updateSlidersFromState();
    await sendCustomEQ();
    log(`Custom preset "${preset.name}" applied`);
  }

  function updateSlidersFromState() {
    for (let i = 0; i < NUM_BANDS; i++) {
      const slider = document.getElementById(`eq-slider-${i}`);
      if (slider) slider.value = bandGains[i];
      const dbEl = document.getElementById(`db-val-${i}`);
      if (dbEl) {
        const db = decodeGain(bandGains[i]);
        dbEl.textContent = db >= 0 ? `+${db.toFixed(1)}` : db.toFixed(1);
      }
    }
  }

  // =========================================================================
  // Notification Handler
  // =========================================================================

  function onNotification(event) {
    const value = new Uint8Array(event.target.value.buffer);
    log("RX ← " + hexStr(value));

    // Check QXW prefix
    if (
      value.length < 5 ||
      value[0] !== 0x51 ||
      value[1] !== 0x58 ||
      value[2] !== 0x57
    ) {
      log("Unknown packet (no QXW prefix)");

      return;
    }

    const cmd = value[3];

    if (cmd === CMD_DEVICE_INFO && value[4] === 0x02) {
      parseDeviceInfo(value.slice(5));
    } else if (cmd === CMD_SELECT_EQ) {
      log("Preset change confirmed");
    } else if (cmd === CMD_CUSTOM_EQ) {
      log("Custom EQ confirmed");
    } else {
      log(`Unknown command: 0x${cmd.toString(16)}`);
    }
  }

  function parseDeviceInfo(payload) {
    if (payload.length < 5) {
      log("Device info payload too short");

      return;
    }

    const batteryLeft = payload[2];
    const batteryRight = payload[3];

    // Extract device name: scan backwards for length-prefixed ASCII string
    let deviceName = "";
    for (let i = payload.length - 1; i >= 5; i--) {
      const nameLen = payload[i];
      if (nameLen > 0 && nameLen < 32 && i + 1 + nameLen <= payload.length) {
        const nameBytes = payload.slice(i + 1, i + 1 + nameLen);
        let valid = true;
        let name = "";
        for (let j = 0; j < nameBytes.length; j++) {
          if (nameBytes[j] < 0x20 || nameBytes[j] > 0x7e) {
            valid = false;
            break;
          }
          name += String.fromCharCode(nameBytes[j]);
        }
        if (valid && name.length === nameLen) {
          deviceName = name;
          break;
        }
      }
    }

    log(
      `Battery: L=${batteryLeft}% R=${batteryRight}%` +
      (deviceName ? ` Name: ${deviceName}` : "")
    );

    // Update UI
    document.getElementById("bat-left").textContent = batteryLeft + "%";
    document.getElementById("bat-right").textContent = batteryRight + "%";
    document.getElementById("device-name").textContent = deviceName;
    document.getElementById("info-card").classList.remove("hidden");
  }

  // =========================================================================
  // Connection
  // =========================================================================

  /**
   * Try to establish the full GATT connection on a BluetoothDevice.
   *
   * Connects GATT, discovers the Fairbuds service + characteristics, and starts notifications.  Returns true on
   * success, false on failure (the caller decides what to do next).
   */
  async function connectToDevice(dev) {
    const statusEl = document.getElementById("status");

    device = dev;
    device.addEventListener("gattserverdisconnected", onDisconnected);

    log(`Trying device: ${device.name || device.id}`);
    statusEl.textContent = "Connecting…";

    try {
      server = await device.gatt.connect();
    } catch (gattErr) {
      log("GATT connect failed for this device.");
      cleanup();

      return false;
    }

    log("GATT server connected");

    try {
      const service = await server.getPrimaryService(SERVICE_UUID);
      log("Service obtained");

      writeChar = await service.getCharacteristic(WRITE_UUID);
      notifyChar = await service.getCharacteristic(NOTIFY_UUID);
      log("Characteristics obtained");

      await notifyChar.startNotifications();
      notifyChar.addEventListener("characteristicvaluechanged", onNotification);
      log("Notifications started");
    } catch (serviceErr) {
      log("Fairbuds EQ service not found on this device.");
      console.error(serviceErr);
      try {
        server.disconnect();
      } catch (_) {
        /* ignore */
      }
      cleanup();

      return false;
    }

    return true;
  }

  async function connect() {
    const statusEl = document.getElementById("status");
    const connectBtn = document.getElementById("connect-btn");
    const disconnectBtn = document.getElementById("disconnect-btn");

    try {
      connectBtn.disabled = true;
      statusEl.textContent = "Scanning…";
      statusEl.className = "";

      log("Requesting Bluetooth device…");
      const picked = await navigator.bluetooth.requestDevice({
        filters: [
          {
            namePrefix: "Fairbuds",
            // Service data filter for BLE devices instead of "services"
            serviceData: [
              { service: SERVICE_UUID },
              { service: NOTIFY_UUID },
              { service: WRITE_UUID },
            ],
          },
        ],
        optionalServices: [SERVICE_UUID],
      });

      const ok = await connectToDevice(picked);
      if (!ok) {
        log(
          "That Fairbuds entry didn't have the EQ service — please click Connect again and pick the other entry."
        );
        statusEl.textContent =
          "Wrong device — click Connect and choose the other Fairbuds entry";
        statusEl.className = "error";
        connectBtn.disabled = false;

        return;
      }

      connected = true;
      statusEl.textContent =
        "Connected" + (device.name ? ` — ${device.name}` : "");
      statusEl.className = "connected";
      connectBtn.disabled = false;
      connectBtn.style.display = "none";
      disconnectBtn.style.display = "";

      // Show UI cards
      document.getElementById("presets-card").classList.remove("hidden");
      document.getElementById("eq-card").classList.remove("hidden");
      enableControls(true);

      // Request device info
      await requestDeviceInfo();
    } catch (err) {
      log("Connection error: " + err.message);
      statusEl.textContent = "Error: " + err.message;
      statusEl.className = "error";
      connectBtn.disabled = false;
      connected = false;
    }
  }

  async function disconnect() {
    const statusEl = document.getElementById("status");
    const connectBtn = document.getElementById("connect-btn");
    const disconnectBtn = document.getElementById("disconnect-btn");

    try {
      if (notifyChar) {
        notifyChar.removeEventListener(
          "characteristicvaluechanged",
          onNotification
        );
        await notifyChar.stopNotifications();
        log("Notifications stopped");
      }
      await delay(300);

      if (server && server.connected) {
        server.disconnect();
        log("Disconnected");
      }
    } catch (err) {
      log("Disconnect error: " + err.message);
    }

    cleanup();
    statusEl.textContent = "Disconnected";
    statusEl.className = "";
    connectBtn.style.display = "";
    connectBtn.disabled = false;
    disconnectBtn.style.display = "none";
  }

  function onDisconnected() {
    log("Device disconnected");
    cleanup();
    const statusEl = document.getElementById("status");
    const connectBtn = document.getElementById("connect-btn");
    const disconnectBtn = document.getElementById("disconnect-btn");
    statusEl.textContent = "Disconnected";
    statusEl.className = "";
    connectBtn.style.display = "";
    connectBtn.disabled = false;
    disconnectBtn.style.display = "none";
  }

  function cleanup() {
    connected = false;
    writeChar = null;
    notifyChar = null;
    server = null;
    enableControls(false);
  }

  function enableControls(enabled) {
    document.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.disabled = !enabled;
    });
    document.getElementById("eq-apply").disabled = !enabled;
    document.getElementById("eq-reset").disabled = !enabled;
    document.querySelectorAll("#eq-sliders input").forEach((inp) => {
      inp.disabled = !enabled;
    });
  }

  // =========================================================================
  // EQ Slider UI
  // =========================================================================

  function buildEQSliders() {
    const container = document.getElementById("eq-sliders");
    container.innerHTML = "";

    for (let i = 0; i < NUM_BANDS; i++) {
      const band = document.createElement("div");
      band.className = "eq-band";

      const dbVal = document.createElement("div");
      dbVal.className = "db-val";
      dbVal.id = `db-val-${i}`;
      dbVal.textContent = "0.0";

      const sliderWrap = document.createElement("div");
      sliderWrap.className = "slider-wrap";

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = 0;
      slider.max = 255;
      slider.value = GAIN_OFFSET; // 0 dB
      slider.id = `eq-slider-${i}`;
      slider.dataset.band = i;

      slider.addEventListener("input", function () {
        const idx = parseInt(this.dataset.band);
        bandGains[idx] = parseInt(this.value);
        const db = decodeGain(bandGains[idx]);
        document.getElementById(`db-val-${idx}`).textContent =
          db >= 0 ? `+${db.toFixed(1)}` : db.toFixed(1);
      });

      const freqLabel = document.createElement("div");
      freqLabel.className = "freq-label";
      freqLabel.textContent = formatFreq(FREQUENCIES[i]);

      sliderWrap.appendChild(slider);
      band.appendChild(dbVal);
      band.appendChild(sliderWrap);
      band.appendChild(freqLabel);
      container.appendChild(band);
    }
  }

  function resetSliders() {
    for (let i = 0; i < NUM_BANDS; i++) {
      bandGains[i] = GAIN_OFFSET;
      bandQs[i] = DEFAULT_Q;
      const slider = document.getElementById(`eq-slider-${i}`);
      if (slider) slider.value = GAIN_OFFSET;
      const dbEl = document.getElementById(`db-val-${i}`);
      if (dbEl) dbEl.textContent = "0.0";
    }
  }

  // =========================================================================
  // Event Wiring
  // =========================================================================

  document.getElementById("connect-btn").addEventListener("click", connect);
  document
    .getElementById("disconnect-btn")
    .addEventListener("click", disconnect);

  // Preset buttons
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", async function () {
      if (!connected) {
        return;
      }

      const presetNum = parseInt(this.dataset.preset);

      // Highlight active preset
      document
        .querySelectorAll(".preset-btn")
        .forEach((b) => b.classList.remove("active"));
      this.classList.add("active");

      await selectPreset(presetNum);
    });
  });

  // Apply custom EQ
  document.getElementById("eq-apply").addEventListener("click", async () => {
    if (!connected) {
      return;
    }

    // Clear preset highlight when using custom EQ
    document
      .querySelectorAll(".preset-btn")
      .forEach((b) => b.classList.remove("active"));

    await sendCustomEQ();
  });

  // Reset flat
  document.getElementById("eq-reset").addEventListener("click", () => {
    resetSliders();
    log("EQ reset to flat");
  });

  // Build custom preset buttons
  (function buildCustomPresetButtons() {
    const container = document.getElementById("custom-presets");

    function addPresetButtons(presets, containerEl) {
      presets.forEach((preset) => {
        const btn = document.createElement("button");
        btn.className = "preset-btn";
        btn.textContent = preset.name;
        if (preset.recommended) {
          const badge = document.createElement("span");
          badge.className = "badge";
          badge.textContent = "recommended";
          btn.appendChild(badge);
        }
        btn.addEventListener("click", async function () {
          if (!connected) return;
          document
            .querySelectorAll(".preset-btn")
            .forEach((b) => b.classList.remove("active"));
          this.classList.add("active");
          await applyCustomPreset(preset);
        });
        containerEl.appendChild(btn);
      });
    }

    addPresetButtons(CUSTOM_PRESETS, container);

    const appContainer = document.getElementById("app-presets");
    addPresetButtons(APP_PRESETS, appContainer);
  })();

  // Build sliders on load
  buildEQSliders();
  enableControls(false);

  // Check Web Bluetooth support
  if (!navigator.bluetooth) {
    log(
      "Web Bluetooth is not supported in this browser. Use Chrome or Edge on a supported platform."
    );
    document.getElementById("connect-btn").disabled = true;
    document.getElementById("status").textContent =
      "Web Bluetooth not supported";
    document.getElementById("status").className = "error";
  } else {
    log("Ready — click Connect to pair with your Fairbuds");
  }
})();
