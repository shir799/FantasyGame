/**
 * NetworkClient.js — WebSocket-Client mit Nachrichten-Dispatch und
 * Clock-Offset-Schätzung. Verbindet zu ws://location.host, verteilt
 * eingehende Nachrichten typbasiert an Handler und sendet den lokalen
 * Spielerzustand mit STATE_HZ über startStateLoop().
 */

import { MSG, STATE_HZ } from '/shared/protocol.js';

// Anzahl der Offset-Messungen, über die gemittelt wird.
const MAX_OFFSET_SAMPLES = 10;

export class NetworkClient {
  constructor() {
    this._ws = null;
    this._connectPromise = null;
    this._handlers = new Map();    // type → [handler, ...]
    this._closeCbs = [];
    this._id = null;
    this._lanIp = null;
    this._port = null;
    this._offsetSamples = [];      // serverNow - Date.now() je Messung
    this._offset = 0;
    this._stateTimer = null;
    this._stateWarned = false;
  }

  /** Verbindung aufbauen; resolved erst nach S_WELCOME. */
  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(`ws://${location.host}`);
      } catch (err) {
        this._connectPromise = null;
        reject(err);
        return;
      }
      this._ws = ws;

      ws.addEventListener('message', (ev) => {
        const msg = this._parse(ev.data);
        if (!msg) return;
        this._handleMessage(msg);
        if (msg.type === MSG.S_WELCOME && !settled) {
          settled = true;
          resolve();
        }
      });

      ws.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        this._connectPromise = null;
        reject(new Error('WebSocket-Verbindungsfehler'));
      });

      ws.addEventListener('close', () => {
        this.stopStateLoop();
        this._ws = null;
        this._connectPromise = null;   // erlaubt späteren Neuverbindungsversuch
        if (!settled) {
          settled = true;
          reject(new Error('Verbindung vor S_WELCOME geschlossen'));
          return;
        }
        for (const cb of this._closeCbs) {
          try {
            cb();
          } catch (err) {
            console.warn('NetworkClient: onClose-Callback fehlgeschlagen', err);
          }
        }
      });
    });
    return this._connectPromise;
  }

  /** Handler für einen Nachrichtentyp registrieren (mehrere erlaubt). */
  on(type, handler) {
    if (!type || typeof handler !== 'function') return;
    let list = this._handlers.get(type);
    if (!list) {
      list = [];
      this._handlers.set(type, list);
    }
    list.push(handler);
  }

  /** Nachricht senden; ohne Verbindung wird still ignoriert. */
  send(type, payload = {}) {
    if (!type || !this.connected) return;
    try {
      this._ws.send(JSON.stringify({ type, ...payload }));
    } catch (err) {
      // Socket kann zwischen Check und send schließen — still ignorieren.
    }
  }

  /** Eigene Spieler-ID (nach S_WELCOME, sonst null). */
  get id() {
    return this._id;
  }

  /** Vom Server gemeldete LAN-IP (nach S_WELCOME, sonst null). */
  get lanIp() {
    return this._lanIp;
  }

  /** Aktuelle Zeit in Server-Millisekunden. */
  serverNow() {
    return Date.now() + this._offset;
  }

  /** C_STATE-Loop starten; Guard gegen Doppelstart. */
  startStateLoop(getState) {
    if (this._stateTimer !== null || typeof getState !== 'function') return;
    this._stateTimer = setInterval(() => {
      if (!this.connected) return;
      let state = null;
      try {
        state = getState();
      } catch (err) {
        if (!this._stateWarned) {
          this._stateWarned = true;
          console.warn('NetworkClient: getState() fehlgeschlagen', err);
        }
        return;
      }
      if (state) this.send(MSG.C_STATE, state);
    }, 1000 / STATE_HZ);
  }

  /** C_STATE-Loop stoppen (no-op, wenn nicht aktiv). */
  stopStateLoop() {
    if (this._stateTimer === null) return;
    clearInterval(this._stateTimer);
    this._stateTimer = null;
  }

  /** Ist der Socket offen? */
  get connected() {
    return !!this._ws && this._ws.readyState === WebSocket.OPEN;
  }

  /** Callback bei Verbindungsende registrieren. */
  onClose(cb) {
    if (typeof cb === 'function') this._closeCbs.push(cb);
  }

  // --- interne Helfer ---

  /** Rohdaten robust parsen; ungültige Nachrichten → null. */
  _parse(data) {
    if (typeof data !== 'string') return null;   // Binärdaten ignorieren
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      console.warn('NetworkClient: ungültiges JSON empfangen');
      return null;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return null;
    return msg;
  }

  /** Interne Buchführung + Dispatch an registrierte Handler. */
  _handleMessage(msg) {
    if (msg.type === MSG.S_WELCOME) {
      if (msg.id != null) this._id = msg.id;
      if (msg.lanIp != null) this._lanIp = msg.lanIp;
      if (msg.port != null) this._port = msg.port;
      this._addOffsetSample(msg.now);
    } else if (msg.type === MSG.S_PHASE) {
      this._addOffsetSample(msg.now);
    }
    const list = this._handlers.get(msg.type);
    if (!list) return;
    for (const handler of list) {
      try {
        handler(msg);
      } catch (err) {
        console.warn(`NetworkClient: Handler für "${msg.type}" fehlgeschlagen`, err);
      }
    }
  }

  /** Offset-Messung aufnehmen und Mittelwert neu bilden. */
  _addOffsetSample(serverNowMs) {
    if (typeof serverNowMs !== 'number' || !Number.isFinite(serverNowMs)) return;
    this._offsetSamples.push(serverNowMs - Date.now());
    if (this._offsetSamples.length > MAX_OFFSET_SAMPLES) this._offsetSamples.shift();
    let sum = 0;
    for (const s of this._offsetSamples) sum += s;
    this._offset = sum / this._offsetSamples.length;
  }
}
