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
  // Preset Loading (from presets/ and presets_app/ directories — AutoEQ format)
  // =========================================================================

  // Loaded at runtime from data.json + text files
  let CUSTOM_PRESETS = [];
  let APP_PRESETS = [];

  /**
   * Parse an AutoEQ preset text file into an array of [gain_db, q_real] pairs.
   * Ignores the Preamp line.
   */
  function parsePresetText(text) {
    const bands = [];
    for (const line of text.split("\n")) {
      const m = line.match(
        /^Filter\s+\d+:\s+ON\s+PK\s+Fc\s+[\d.]+\s+Hz\s+Gain\s+([\d.+-]+)\s+dB\s+Q\s+([\d.]+)/
      );
      if (m) {
        bands.push([parseFloat(m[1]), parseFloat(m[2])]);
      }
    }
    return bands;
  }

  /**
   * Fetch a single preset text file and return a preset object.
   */
  async function fetchPreset(folder, preset) {
    const filename = preset.name
    const resp = await fetch(`${folder}/${filename}`);
    if (!resp.ok) throw new Error(`Failed to fetch ${folder}/${filename}`);
    const text = await resp.text();
    const bands = parsePresetText(text);
    const name = filename.replace(/\.txt$/, "");
    return { name, bands, recommended: preset.recommended || false };
  }

  /**
   * Load data.json and fetch all referenced preset files.
   */
  async function loadPresets() {
    try {
      const resp = await fetch("data.json");
      if (!resp.ok) throw new Error("Failed to fetch data.json");
      const data = await resp.json();

      const [custom, app] = await Promise.all([
        Promise.all((data.presets || []).map((p) => fetchPreset("presets", p))),
        Promise.all((data.presets_app || []).map((p) => fetchPreset("presets_app", p))),
      ]);

      CUSTOM_PRESETS = custom;
      APP_PRESETS = app;
      log(`Loaded ${custom.length} custom + ${app.length} app presets`);
    } catch (err) {
      log("Error loading presets: " + err.message);
    }
  }

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

  async function sendZeroEQ() {
    const payload = new Uint8Array(NUM_BANDS * 3);
    for (let i = 0; i < NUM_BANDS; i++) {
      payload[i * 3] = i;
      payload[i * 3 + 1] = GAIN_OFFSET;
      payload[i * 3 + 2] = DEFAULT_Q;
    }
    const pkt = buildPacket(CMD_CUSTOM_EQ, TYPE_NOTIFY, payload);
    await sendCommand(pkt);
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
    await selectPreset(4);
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
          "That Fairbuds entry didn't have the EQ service — please try again, or choose the other entry."
        );
        statusEl.textContent =
          "Could not connect — please try again, or choose the other Fairbuds entry";
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

      if (presetNum === 4) {
        // Studio: select preset 4, then send zeroed EQ; reset sliders to flat
        await selectPreset(4);
        await sendZeroEQ();
        resetSliders();
      } else {
        // Main / Bass Boost / Flat: send zeroed EQ first, then select preset
        await sendZeroEQ();
        await selectPreset(presetNum);
      }
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

    await selectPreset(4);
    await sendCustomEQ();
  });

  // Reset flat
  document.getElementById("eq-reset").addEventListener("click", () => {
    resetSliders();
    log("EQ reset to flat");
  });

  function addPresetButtons(presets, containerEl) {
    containerEl.innerHTML = "";
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

  // Load presets from data.json, then build buttons
  function refreshPresetButtons() {
    addPresetButtons(CUSTOM_PRESETS, document.getElementById("custom-presets"));
    addPresetButtons(APP_PRESETS, document.getElementById("app-presets"));
  }

  loadPresets().then(refreshPresetButtons);

  document.getElementById("reload-presets-btn").addEventListener("click", () => {
    loadPresets().then(refreshPresetButtons);
  });

  // Build sliders on load
  buildEQSliders();
  enableControls(false);

  // Check Web Bluetooth support
  if (!navigator.bluetooth) {
    log(
      "Web Bluetooth is not supported by this browser."
    );
    document.getElementById("connect-btn").disabled = true;
    document.getElementById("status").innerHTML =
      "Web Bluetooth is not currently supported by your browser. See <a href='https://github.com/jurf/fairbuds/blob/main/docs/web-bluetooth.md'>this guide</a> for more information.";
    document.getElementById("status").className = "error";
  } else {
    log("Ready — click Connect to pair with your Fairbuds");
  }
})();
