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
    log("Requesting device info");
    await sendCommand(pkt);
  }

  async function selectPreset(presetNum) {
    const pkt = buildPacket(
      CMD_SELECT_EQ,
      TYPE_REQUEST,
      new Uint8Array([presetNum])
    );
    log(`Selecting preset ${presetNum}`);
    await sendCommand(pkt);
  }

  async function sendCustomEQ() {
    const payload = new Uint8Array(NUM_BANDS * 3);
    for (let i = 0; i < NUM_BANDS; i++) {
      payload[i * 3] = i;
      payload[i * 3 + 1] = bandGains[i];
      payload[i * 3 + 2] = bandQs[i];
    }
    const pkt = buildPacket(CMD_CUSTOM_EQ, TYPE_NOTIFY, payload);
    log("Sending custom EQ");
    await sendCommand(pkt);
  }

  async function sendZeroEQ() {
    const payload = new Uint8Array(NUM_BANDS * 3);
    for (let i = 0; i < NUM_BANDS; i++) {
      payload[i * 3] = i;
      payload[i * 3 + 1] = GAIN_OFFSET;
      payload[i * 3 + 2] = DEFAULT_Q;
    }
    const pkt = buildPacket(CMD_CUSTOM_EQ, TYPE_NOTIFY, payload);
    log("Resetting custom EQ to zero");
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
    log(`Applying custom EQ "${preset.name}"`);
    await selectPreset(4);
    await sendCustomEQ();
  }

  function updateSlidersFromState() {
    for (let i = 0; i < NUM_BANDS; i++) {
      setSliderValue(i, bandGains[i]);
      setKnobValue(i, bandQs[i] / 10);
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
      log("Custom EQ change confirmed");
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

      // Enable interaction
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
    document.querySelectorAll("[data-action='preset']").forEach((btn) => {
      btn.disabled = !enabled;
    });
    document.getElementById("eq-apply").disabled = !enabled;
    document.getElementById("eq-reset").disabled = !enabled;
    document.querySelectorAll(".custom-slider").forEach((el) => {
      el.style.opacity = enabled ? "" : "0.4";
      el.style.pointerEvents = enabled ? "" : "none";
    });
    document.querySelectorAll(".q-knob").forEach((svg) => {
      svg.style.opacity = enabled ? "" : "0.4";
      svg.style.pointerEvents = enabled ? "" : "none";
    });
  }

  // =========================================================================
  // Q Knob Helpers
  // =========================================================================

  const Q_MIN = 0.1;
  const Q_MAX = 25.5;
  const Q_CENTER = 0.7; // knob midpoint — equal log resolution on either side
  const KNOB_START_DEG = 225; // clockwise from 12 o'clock (~7 o'clock position)
  const KNOB_SWEEP_DEG = 270; // total arc sweep

  function degToPoint(cx, cy, r, clockDeg) {
    const rad = (clockDeg - 90) * (Math.PI / 180);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function describeArc(cx, cy, r, startDeg, spanDeg) {
    if (spanDeg <= 0) return "";
    const endDeg = startDeg + spanDeg;
    const s = degToPoint(cx, cy, r, startDeg);
    const e = degToPoint(cx, cy, r, endDeg);
    const large = spanDeg > 180 ? 1 : 0;
    return (
      `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} ` +
      `A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`
    );
  }

  // Two-segment log scale: Q_MIN→Q_CENTER occupies the lower half of the knob,
  // Q_CENTER→Q_MAX occupies the upper half, so 0.7 sits exactly at the midpoint.
  function qToT(q) {
    if (q <= Q_CENTER) {
      return 0.5 * Math.log(q / Q_MIN) / Math.log(Q_CENTER / Q_MIN);
    }
    return 0.5 + 0.5 * Math.log(q / Q_CENTER) / Math.log(Q_MAX / Q_CENTER);
  }

  function tToQ(t) {
    t = Math.max(0, Math.min(1, t));
    if (t <= 0.5) {
      return Q_MIN * Math.pow(Q_CENTER / Q_MIN, 2 * t);
    }
    return Q_CENTER * Math.pow(Q_MAX / Q_CENTER, 2 * (t - 0.5));
  }

  function setKnobValue(i, val) {
    val = Math.round(Math.max(Q_MIN, Math.min(Q_MAX, val)) * 10) / 10;
    bandQs[i] = Math.max(1, Math.round(val * 10)); // 0 must never be written; protocol precision is 0.1

    const t = qToT(val);
    const cx = 20, cy = 20, r = 14;

    const fillEl = document.getElementById(`knob-fill-${i}`);
    if (fillEl) {
      fillEl.setAttribute("d", val <= Q_MIN ? "" : describeArc(cx, cy, r, KNOB_START_DEG, t * KNOB_SWEEP_DEG));
    }

    const dotEl = document.getElementById(`knob-dot-${i}`);
    if (dotEl) {
      const pt = degToPoint(cx, cy, r, KNOB_START_DEG + t * KNOB_SWEEP_DEG);
      dotEl.setAttribute("cx", pt.x.toFixed(2));
      dotEl.setAttribute("cy", pt.y.toFixed(2));
    }

    const svgEl = document.getElementById(`knob-svg-${i}`);
    if (svgEl) svgEl.setAttribute("aria-valuenow", val.toFixed(1));

    const textEl = document.getElementById(`knob-text-${i}`);
    if (textEl) textEl.textContent = val.toFixed(1);
    scheduleRedraw();
  }

  function createKnob(i) {
    const col = document.createElement("div");
    col.className = "q-col";

    const cx = 20, cy = 20, r = 14;
    const ns = "http://www.w3.org/2000/svg";

    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 40 40");
    svg.classList.add("q-knob");
    svg.id = `knob-svg-${i}`;
    svg.setAttribute("role", "slider");
    svg.setAttribute("aria-label", `Q for ${formatFreq(FREQUENCIES[i])} Hz`);
    svg.setAttribute("aria-valuemin", Q_MIN);
    svg.setAttribute("aria-valuemax", Q_MAX);
    svg.setAttribute("aria-valuenow", (DEFAULT_Q / 10).toFixed(1));
    svg.setAttribute("tabindex", "0");

    // Background track — full sweep, dimmed
    const track = document.createElementNS(ns, "path");
    track.setAttribute("d", describeArc(cx, cy, r, KNOB_START_DEG, KNOB_SWEEP_DEG));
    track.setAttribute("fill", "none");
    track.setAttribute("stroke", "color-mix(in srgb, var(--text) 25%, transparent)");
    track.setAttribute("stroke-width", "1");
    track.setAttribute("stroke-linecap", "round");

    // Value arc — accent-colored, from start to current value
    const fill = document.createElementNS(ns, "path");
    fill.setAttribute("id", `knob-fill-${i}`);
    fill.setAttribute("fill", "none");
    fill.setAttribute("stroke", "var(--accent)");
    fill.setAttribute("stroke-width", "3");
    fill.setAttribute("stroke-linecap", "round");

    // Indicator dot at the current value position on the arc
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("id", `knob-dot-${i}`);
    dot.setAttribute("r", "3");
    dot.setAttribute("fill", "var(--accent)");

    svg.appendChild(track);
    svg.appendChild(fill);

    // Value text centred in the knob — styled like db-val
    const qText = document.createElementNS(ns, "text");
    qText.setAttribute("id", `knob-text-${i}`);
    qText.setAttribute("x", cx);
    qText.setAttribute("y", cy);
    qText.setAttribute("text-anchor", "middle");
    qText.setAttribute("dominant-baseline", "central");
    qText.setAttribute("fill", "var(--text)");
    qText.setAttribute("font-size", "8");
    qText.setAttribute("font-weight", "400");
    qText.setAttribute("pointer-events", "none");
    qText.textContent = (DEFAULT_Q / 10).toFixed(1);

    svg.appendChild(qText);
    svg.appendChild(dot);

    // Vertical drag: 200 px = full t range (two-segment log Q scale)
    let dragStartY = 0;
    let dragStartT = 0;

    svg.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      dragStartY = e.clientY;
      dragStartT = qToT(bandQs[i] / 10);
    });

    svg.addEventListener("pointermove", (e) => {
      if (!svg.hasPointerCapture(e.pointerId)) return;
      const deltaT = (dragStartY - e.clientY) / 200;
      setKnobValue(i, tToQ(dragStartT + deltaT));
    });

    // Scroll wheel: ±0.1 per notch
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      setKnobValue(i, bandQs[i] / 10 + (e.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });

    // Keyboard: arrow keys step by 0.1
    svg.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
        e.preventDefault();
        setKnobValue(i, bandQs[i] / 10 + 0.1);
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
        e.preventDefault();
        setKnobValue(i, bandQs[i] / 10 - 0.1);
      }
    });

    col.appendChild(svg);
    return col;
  }

  // =========================================================================
  // EQ Slider UI
  // =========================================================================

  function setSliderValue(i, encodedVal) {
    encodedVal = Math.max(0, Math.min(255, Math.round(encodedVal)));
    bandGains[i] = encodedVal;

    const pct = (encodedVal / 255) * 100;
    const zeroPct = (GAIN_OFFSET / 255) * 100;
    const thumbEl = document.getElementById(`eq-thumb-${i}`);
    if (thumbEl) thumbEl.style.bottom = pct + "%";

    const fillEl = document.getElementById(`eq-fill-${i}`);
    if (fillEl) {
      fillEl.style.bottom = Math.min(pct, zeroPct) + "%";
      fillEl.style.height = Math.abs(pct - zeroPct) + "%";
    }

    const sliderEl = document.getElementById(`eq-slider-${i}`);
    if (sliderEl) sliderEl.setAttribute("aria-valuenow", encodedVal);

    const db = decodeGain(encodedVal);
    const dbEl = document.getElementById(`db-val-${i}`);
    if (dbEl) dbEl.textContent = db >= 0 ? `+${db.toFixed(1)}` : `\u2212${Math.abs(db).toFixed(1)}`;
    scheduleRedraw();
  }

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

      const customSlider = document.createElement("div");
      customSlider.className = "custom-slider";
      customSlider.id = `eq-slider-${i}`;
      customSlider.setAttribute("role", "slider");
      customSlider.setAttribute("aria-label", `Gain for ${formatFreq(FREQUENCIES[i])} Hz`);
      customSlider.setAttribute("aria-valuemin", 0);
      customSlider.setAttribute("aria-valuemax", 255);
      customSlider.setAttribute("aria-valuenow", GAIN_OFFSET);
      customSlider.setAttribute("tabindex", "0");

      const fill = document.createElement("div");
      fill.className = "custom-slider-fill";
      fill.id = `eq-fill-${i}`;
      fill.style.bottom = ((GAIN_OFFSET / 255) * 100) + "%";
      fill.style.height = "0%";
      customSlider.appendChild(fill);

      const thumb = document.createElement("div");
      thumb.className = "custom-slider-thumb";
      thumb.id = `eq-thumb-${i}`;
      thumb.style.bottom = ((GAIN_OFFSET / 255) * 100) + "%";
      customSlider.appendChild(thumb);

      let sliderRect = null;
      customSlider.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        customSlider.setPointerCapture(e.pointerId);
        sliderRect = customSlider.getBoundingClientRect();
        const t = 1 - (e.clientY - sliderRect.top) / sliderRect.height;
        setSliderValue(i, Math.round(t * 255));
      });

      customSlider.addEventListener("pointermove", (e) => {
        if (!customSlider.hasPointerCapture(e.pointerId)) return;
        const t = 1 - (e.clientY - sliderRect.top) / sliderRect.height;
        setSliderValue(i, Math.round(t * 255));
      });

      customSlider.addEventListener("wheel", (e) => {
        e.preventDefault();
        setSliderValue(i, bandGains[i] + (e.deltaY < 0 ? 1 : -1));
      }, { passive: false });

      customSlider.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowRight") {
          e.preventDefault();
          setSliderValue(i, bandGains[i] + 1);
        } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
          e.preventDefault();
          setSliderValue(i, bandGains[i] - 1);
        }
      });

      const freqLabel = document.createElement("div");
      freqLabel.className = "freq-label";
      freqLabel.textContent = formatFreq(FREQUENCIES[i]);

      sliderWrap.appendChild(customSlider);
      band.appendChild(dbVal);
      band.appendChild(sliderWrap);
      band.appendChild(freqLabel);
      container.appendChild(band);
    }

    const qRow = document.getElementById("q-row");
    qRow.innerHTML = "";
    for (let i = 0; i < NUM_BANDS; i++) {
      qRow.appendChild(createKnob(i));
      setKnobValue(i, DEFAULT_Q / 10);
    }
  }

  function resetSliders() {
    for (let i = 0; i < NUM_BANDS; i++) {
      bandQs[i] = DEFAULT_Q;
      setSliderValue(i, GAIN_OFFSET);
      setKnobValue(i, DEFAULT_Q / 10);
    }
  }

  // =========================================================================
  // EQ Frequency Response Visualizer
  // =========================================================================

  const SAMPLE_RATE = 44100;
  const VIZ_DB_MIN = -12;
  const VIZ_DB_MAX = 13.5;
  const VIZ_FREQ_MIN = 20;
  const VIZ_FREQ_MAX = 20000;
  const VIZ_CURVE_POINTS = 512;

  let vizCanvas = null;
  let vizDirty = false;
  let vizHoverX = null;

  // Peaking biquad magnitude response (Audio EQ Cookbook — RBJ).
  // Returns dB; short-circuits to 0 when gainDb ≈ 0.
  function peakingMagnitudeDb(freq, fc, gainDb, Q) {
    if (Math.abs(gainDb) < 0.001) return 0;

    const A = Math.pow(10, gainDb / 40); // sqrt(10^(dB/20))
    const w0 = 2 * Math.PI * fc / SAMPLE_RATE;
    const sinW0 = Math.sin(w0);
    const cosW0 = Math.cos(w0);
    const alpha = sinW0 / (2 * Q);

    const b0 = 1 + alpha * A;
    const b1 = -2 * cosW0;
    const b2 = 1 - alpha * A;
    const a0 = 1 + alpha / A;
    // a1 === b1 for peaking EQ
    const a2 = 1 - alpha / A;

    const w = 2 * Math.PI * freq / SAMPLE_RATE;
    const cosW = Math.cos(w);
    const sinW = Math.sin(w);
    const cos2W = Math.cos(2 * w);
    const sin2W = Math.sin(2 * w);

    // H(e^jω) evaluated by substituting z = e^{jω}
    const numRe = b0 + b1 * cosW + b2 * cos2W;
    const numIm = - b1 * sinW - b2 * sin2W;
    const denRe = a0 + b1 * cosW + a2 * cos2W;
    const denIm = - b1 * sinW - a2 * sin2W;

    const mag2 = (numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm);
    return 10 * Math.log10(mag2);
  }

  // Sum all 8 peaking filter responses at each frequency in freqs[].
  function computeCurve(freqs) {
    return freqs.map(freq => {
      let db = 0;
      for (let i = 0; i < NUM_BANDS; i++) {
        db += peakingMagnitudeDb(freq, FREQUENCIES[i], decodeGain(bandGains[i]), bandQs[i] / 10);
      }
      return db;
    });
  }

  function scheduleRedraw() {
    if (!vizDirty) {
      vizDirty = true;
      requestAnimationFrame(redrawViz);
    }
  }

  function redrawViz() {
    vizDirty = false;
    drawEQ();
  }

  function drawEQ() {
    if (!vizCanvas) return;

    const dpr = window.devicePixelRatio || 1;
    const w = vizCanvas.width / dpr;
    const h = vizCanvas.height / dpr;
    if (w <= 0 || h <= 0) return;

    const cs = getComputedStyle(document.documentElement);
    const colorBg = cs.getPropertyValue('--bg').trim();
    const colorBrand = cs.getPropertyValue('--brand').trim();
    const colorAccent = cs.getPropertyValue('--accent').trim();
    const colorText = cs.getPropertyValue('--text').trim();

    const ctx = vizCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padLeft = 34;
    const padRight = 28;
    const padTop = 12;
    const padBottom = 22;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;
    if (plotW <= 0 || plotH <= 0) return;

    function freqToX(f) {
      return padLeft + (Math.log10(f / VIZ_FREQ_MIN) / Math.log10(VIZ_FREQ_MAX / VIZ_FREQ_MIN)) * plotW;
    }
    function dbToY(db) {
      return padTop + (1 - (db - VIZ_DB_MIN) / (VIZ_DB_MAX - VIZ_DB_MIN)) * plotH;
    }

    const zeroY = dbToY(0);

    // Horizontal dB grid lines
    for (const db of [-12, -9, -6, -3, 0, 3, 6, 9, 12]) {
      const y = dbToY(db);
      ctx.save();
      if (db === 0) {
        ctx.strokeStyle = colorBrand;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 1.5;
      } else {
        ctx.strokeStyle = colorText;
        ctx.globalAlpha = 0.12;
        ctx.lineWidth = 1;
      }
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();
      ctx.restore();
    }

    // Vertical band-frequency grid lines
    ctx.save();
    ctx.strokeStyle = colorText;
    ctx.globalAlpha = 0.12;
    ctx.lineWidth = 1;
    for (const fc of FREQUENCIES) {
      const x = freqToX(fc);
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();
    }
    ctx.restore();

    // Hearing-limit lines at 20 Hz and 20 kHz
    ctx.save();
    ctx.strokeStyle = colorText;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (const fc of [VIZ_FREQ_MIN, VIZ_FREQ_MAX]) {
      const x = freqToX(fc);
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();
    }
    ctx.restore();

    // Build log-spaced frequency array and compute curve
    const freqs = [];
    for (let i = 0; i < VIZ_CURVE_POINTS; i++) {
      const t = i / (VIZ_CURVE_POINTS - 1);
      freqs.push(VIZ_FREQ_MIN * Math.pow(VIZ_FREQ_MAX / VIZ_FREQ_MIN, t));
    }
    const curve = computeCurve(freqs);
    const xs = freqs.map(freqToX);
    const ys = curve.map(dbToY);

    // Fill between curve and 0 dB baseline
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xs[0], zeroY);
    for (let i = 0; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]);
    ctx.lineTo(xs[xs.length - 1], zeroY);
    ctx.closePath();
    ctx.fillStyle = colorAccent;
    ctx.globalAlpha = 0.2;
    ctx.fill();
    ctx.restore();

    // Curve stroke
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]);
    ctx.strokeStyle = colorAccent;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Band markers — 5 px circles on the curve at each band frequency
    ctx.save();
    ctx.fillStyle = colorAccent;
    for (let i = 0; i < NUM_BANDS; i++) {
      const x = freqToX(FREQUENCIES[i]);
      let db = 0;
      for (let j = 0; j < NUM_BANDS; j++) {
        db += peakingMagnitudeDb(FREQUENCIES[i], FREQUENCIES[j], decodeGain(bandGains[j]), bandQs[j] / 10);
      }
      ctx.beginPath();
      ctx.arc(x, dbToY(db), 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // dB axis labels + title
    ctx.save();
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = colorText;
    ctx.globalAlpha = 0.5;
    ctx.textBaseline = 'middle';
    for (const db of [12, 6, 0, -6, -12]) {
      ctx.fillText((db > 0 ? '+' : '') + db, padLeft - 4, dbToY(db));
    }
    ctx.textBaseline = 'bottom';
    ctx.fillText('dB', padLeft - 4, padTop - 2);
    ctx.restore();

    // Frequency axis labels (band freqs + 20 Hz / 20 kHz limits)
    ctx.save();
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colorText;
    ctx.globalAlpha = 0.5;
    for (const fc of [VIZ_FREQ_MIN, ...FREQUENCIES, VIZ_FREQ_MAX]) {
      const x = freqToX(fc);
      ctx.textAlign = fc === VIZ_FREQ_MIN ? 'left' : fc === VIZ_FREQ_MAX ? 'right' : 'center';
      ctx.fillText(formatFreq(fc), x, padTop + plotH + 4);
    }
    // Hz axis title — right of all freq labels
    ctx.textAlign = 'right';
    ctx.fillText('Hz', w - 4, padTop + plotH + 4);
    ctx.restore();

    // Hover crosshair + tooltip
    if (vizHoverX !== null) {
      const cx = Math.max(padLeft, Math.min(padLeft + plotW, vizHoverX));
      const t = (cx - padLeft) / plotW;
      const hoverFreq = VIZ_FREQ_MIN * Math.pow(VIZ_FREQ_MAX / VIZ_FREQ_MIN, t);
      let hoverDb = 0;
      for (let i = 0; i < NUM_BANDS; i++) {
        hoverDb += peakingMagnitudeDb(hoverFreq, FREQUENCIES[i], decodeGain(bandGains[i]), bandQs[i] / 10);
      }
      const cy = dbToY(hoverDb);

      // Vertical crosshair line
      ctx.save();
      ctx.strokeStyle = colorText;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, padTop);
      ctx.lineTo(cx, padTop + plotH);
      ctx.stroke();
      ctx.restore();

      // Dot on curve
      ctx.save();
      ctx.fillStyle = colorAccent;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Tooltip
      const freqStr = hoverFreq >= 1000
        ? (hoverFreq / 1000).toFixed(1) + '\u202fkHz'
        : Math.round(hoverFreq) + '\u202fHz';
      const dbStr = (hoverDb >= 0 ? '+' : '\u2212') + Math.abs(hoverDb).toFixed(1) + '\u202fdB';
      const label = freqStr + '   ' + dbStr;

      ctx.save();
      ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
      const tw = ctx.measureText(label).width;
      const th = 13;
      const tp = 5;
      const gap = 10;
      let tx = cx + gap;
      let ty = cy - th / 2 - tp;
      if (tx + tw + tp * 2 > padLeft + plotW + 4) tx = cx - gap - tw - tp * 2;
      ty = Math.max(padTop + 2, Math.min(padTop + plotH - th - tp * 2 - 2, ty));
      ctx.fillStyle = colorBrand;
      ctx.globalAlpha = 0.92;
      ctx.beginPath();
      ctx.roundRect(tx - tp, ty, tw + tp * 2, th + tp * 2, 4);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = colorBg;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, tx, ty + tp + th / 2);
      ctx.restore();
    }
  }

  function initVisualizer() {
    vizCanvas = document.getElementById('eq-viz');
    if (!vizCanvas) return;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      vizCanvas.width = Math.round(vizCanvas.offsetWidth * dpr);
      vizCanvas.height = Math.round(vizCanvas.offsetHeight * dpr);
      scheduleRedraw();
    }

    new ResizeObserver(resize).observe(vizCanvas);
    new MutationObserver(() => scheduleRedraw()).observe(
      document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] }
    );

    vizCanvas.addEventListener('pointermove', (e) => {
      const rect = vizCanvas.getBoundingClientRect();
      vizHoverX = e.clientX - rect.left;
      scheduleRedraw();
    });
    vizCanvas.addEventListener('pointerleave', () => {
      vizHoverX = null;
      scheduleRedraw();
    });

    scheduleRedraw();
  }

  // =========================================================================
  // Event Wiring
  // =========================================================================

  document.getElementById("connect-btn").addEventListener("click", connect);
  document
    .getElementById("disconnect-btn")
    .addEventListener("click", disconnect);

  // Preset buttons
  document.querySelectorAll("[data-action='preset']").forEach((btn) => {
    btn.addEventListener("click", async function () {
      if (!connected) {
        return;
      }

      const presetNum = parseInt(this.dataset.preset);

      // Highlight active preset
      document
        .querySelectorAll("[data-action='preset']")
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
      .querySelectorAll("[data-action='preset']")
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
      btn.dataset.action = "preset";
      btn.className = "btn btn-secondary";
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
          .querySelectorAll("[data-action='preset']")
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
    if (!connected) enableControls(false);
  }

  loadPresets().then(refreshPresetButtons);

  document.getElementById("reload-presets-btn").addEventListener("click", () => {
    loadPresets().then(refreshPresetButtons);
  });

  // Build sliders on load
  buildEQSliders();
  initVisualizer();
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

  // Info toggles
  document.querySelectorAll("[data-action='info-toggle']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const content = document.getElementById(btn.getAttribute("aria-controls"));
      const open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!open));
      content.classList.toggle("hidden", open);
    });
  });

  // =========================================================================
  // Theme Toggle
  // =========================================================================

  (function initTheme() {
    const root = document.documentElement;
    const btn = document.getElementById("theme-toggle");
    const mq = window.matchMedia("(prefers-color-scheme: dark)");

    const SUN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.25a.75.75 0 01.75.75v2.25a.75.75 0 01-1.5 0V3a.75.75 0 01.75-.75zM7.5 12a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM18.894 6.166a.75.75 0 00-1.06-1.06l-1.591 1.59a.75.75 0 101.06 1.061l1.591-1.59zM21.75 12a.75.75 0 01-.75.75h-2.25a.75.75 0 010-1.5H21a.75.75 0 01.75.75zM17.834 18.894a.75.75 0 001.06-1.06l-1.59-1.591a.75.75 0 10-1.061 1.06l1.59 1.591zM12 18a.75.75 0 01.75.75V21a.75.75 0 01-1.5 0v-2.25A.75.75 0 0112 18zM7.772 18.894a.75.75 0 00-1.06 1.06l1.59 1.591a.75.75 0 001.061-1.06l-1.591-1.591zM6 12a.75.75 0 01-.75.75H3a.75.75 0 010-1.5h2.25A.75.75 0 016 12zM6.166 5.106a.75.75 0 00-1.06 1.06l1.59 1.591a.75.75 0 001.061-1.06l-1.591-1.591z"/></svg>';
    const MOON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.528 1.718a.75.75 0 01.162.819A8.97 8.97 0 009 6a9 9 0 009 9 8.97 8.97 0 003.463-.69.75.75 0 01.981.98 10.503 10.503 0 01-9.694 6.46c-5.799 0-10.5-4.701-10.5-10.5 0-4.368 2.667-8.112 6.46-9.694a.75.75 0 01.818.162z"/></svg>';
    const AUTO_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.25 5.25a3 3 0 013-3h13.5a3 3 0 013 3V15a3 3 0 01-3 3h-3v.257c0 .597.237 1.17.659 1.591l.621.622a.75.75 0 01-.53 1.28h-9a.75.75 0 01-.53-1.28l.621-.622A2.25 2.25 0 009 18.257V18h-3a3 3 0 01-3-3V5.25zm1.5 0v7.5a1.5 1.5 0 001.5 1.5h13.5a1.5 1.5 0 001.5-1.5v-7.5a1.5 1.5 0 00-1.5-1.5H5.25a1.5 1.5 0 00-1.5 1.5z"/></svg>';

    // stored: "dark" | "light" | null (= follow browser)
    function applyTheme(stored) {
      root.setAttribute("data-theme", stored || (mq.matches ? "dark" : "light"));
    }

    function updateBtn(stored) {
      if (stored === "dark") {
        btn.innerHTML = MOON_SVG;
        btn.title = "Dark mode (click for light)";
      } else if (stored === "light") {
        btn.innerHTML = SUN_SVG;
        btn.title = "Light mode (click for browser preference)";
      } else {
        btn.innerHTML = AUTO_SVG;
        btn.title = "Browser preference (click for dark)";
      }
    }

    var current = localStorage.getItem("theme"); // "dark" | "light" | null
    applyTheme(current);
    updateBtn(current);

    // Keep in sync when the system preference changes while in auto mode
    mq.addEventListener("change", function () {
      if (!localStorage.getItem("theme")) applyTheme(null);
    });

    btn.addEventListener("click", function () {
      var stored = localStorage.getItem("theme");
      var next = stored === null ? "dark" : stored === "dark" ? "light" : null;
      if (next) localStorage.setItem("theme", next);
      else localStorage.removeItem("theme");
      applyTheme(next);
      updateBtn(next);
    });
  })();
})();
