// ═══════════════════════════════════════════════════════════════
//  EnviroNet Server — Location-Aware Edition
//  Two nodes connect; users share GPS and see data from nearest.
//
//  Run:   cd server && npm install && node server.js
//  Open:  http://<pi-ip>:3000
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const http    = require('http');
const { WebSocketServer } = require('ws');
const path    = require('path');

const app    = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// ── Node locations — edit to match your real deployment sites ──
// Keep in sync with NODE_LOCATIONS in public/index.html (~line 640)
const NODE_LOCATIONS = {
  node_1: { name: 'Node 1 – Block A', lat: 22.5726, lng: 88.3639, radius: 500, area: 'Kolkata' },
  node_2: { name: 'Node 2 – Block B', lat: 22.5740, lng: 88.3655, radius: 500, area: 'Kolkata' },
};

const MAX_HISTORY    = 200;
const OFFLINE_AFTER_MS = 10000;

const nodeData   = {};
const nodeStatus = {};

function ensureNode(id) {
  if (!nodeData[id])   nodeData[id]   = [];
  if (!nodeStatus[id]) nodeStatus[id] = { lastSeen: null, online: false, totalReadings: 0 };
}

// Pre-create both nodes so they show as offline until they POST
Object.keys(NODE_LOCATIONS).forEach(ensureNode);

app.use(express.json());
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});
app.use(express.static(path.join(__dirname, 'public')));

// ── Receive sensor reading from an ESP32 node ──
app.post('/api/data', (req, res) => {
  const data = req.body;
  if (!data || !data.node_id) return res.status(400).json({ error: 'Missing node_id' });

  const nodeId = data.node_id;
  ensureNode(nodeId);

  const reading = { ...data, server_timestamp: Date.now() };
  nodeData[nodeId].push(reading);
  if (nodeData[nodeId].length > MAX_HISTORY) nodeData[nodeId].shift();

  nodeStatus[nodeId].lastSeen = reading.server_timestamp;
  nodeStatus[nodeId].online   = true;
  nodeStatus[nodeId].totalReadings++;

  // Broadcast new reading to all connected dashboards
  const msg = JSON.stringify({ type: 'reading', data: reading });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });

  const t   = data.temperature     ?? '?';
  const h   = data.humidity        ?? '?';
  const aqi = data.air_quality_adc ?? '?';
  const ws  = data.wind_speed_mps  ?? '?';
  console.log(`[${nodeId}] #${nodeStatus[nodeId].totalReadings} | T:${t}°C H:${h}% AQI:${aqi} Wind:${ws}m/s`);

  res.json({ ok: true });
});

// ── Build full state snapshot ──
function buildState() {
  const now = Date.now();
  Object.keys(nodeStatus).forEach(id => {
    if (nodeStatus[id].lastSeen && now - nodeStatus[id].lastSeen > OFFLINE_AFTER_MS) {
      nodeStatus[id].online = false;
    }
  });

  const history = {};
  Object.keys(nodeData).forEach(id => {
    history[id] = nodeData[id].slice(-60);
  });

  return { nodes: nodeStatus, locations: NODE_LOCATIONS, history };
}

app.get('/api/state',     (req, res) => res.json(buildState()));
app.get('/api/locations', (req, res) => {
  const out = {};
  Object.keys(NODE_LOCATIONS).forEach(id => {
    const latest = nodeData[id]?.length ? nodeData[id][nodeData[id].length - 1] : null;
    out[id] = { ...NODE_LOCATIONS[id], online: nodeStatus[id]?.online || false, latest };
  });
  res.json(out);
});

// ── Latest reading for a specific node ──
app.get('/api/node/:id', (req, res) => {
  const id = req.params.id;
  if (!NODE_LOCATIONS[id]) return res.status(404).json({ error: 'Unknown node' });
  const arr    = nodeData[id] || [];
  const latest = arr.length ? arr[arr.length - 1] : null;
  res.json({
    node_id:  id,
    name:     NODE_LOCATIONS[id].name,
    online:   nodeStatus[id]?.online || false,
    latest,
    readings: arr.slice(-60),
  });
});

// ── Haversine distance (metres) ──
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Nearest node — returns node info + latest sensor data ──
app.get('/api/nearest', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'Provide ?lat=&lng=' });

  let nearest = null, minDist = Infinity;
  Object.keys(NODE_LOCATIONS).forEach(id => {
    const d = haversine(lat, lng, NODE_LOCATIONS[id].lat, NODE_LOCATIONS[id].lng);
    if (d < minDist) { minDist = d; nearest = id; }
  });

  const loc    = NODE_LOCATIONS[nearest];
  const arr    = nodeData[nearest] || [];
  const latest = arr.length ? arr[arr.length - 1] : null;

  res.json({
    nearest_node: nearest,
    name:         loc.name,
    area:         loc.area,
    distance_m:   Math.round(minDist),
    in_geofence:  minDist <= (loc.radius || 500),
    online:       nodeStatus[nearest]?.online || false,
    latest,
    all_nodes: Object.keys(NODE_LOCATIONS).map(id => ({
      id,
      name:       NODE_LOCATIONS[id].name,
      distance_m: Math.round(haversine(lat, lng, NODE_LOCATIONS[id].lat, NODE_LOCATIONS[id].lng)),
      online:     nodeStatus[id]?.online || false,
    })).sort((a, b) => a.distance_m - b.distance_m),
  });
});

app.get('/api/health', (req, res) => res.json({
  status: 'running',
  uptime: process.uptime(),
  nodes: Object.keys(nodeStatus).map(id => ({
    id,
    name:     NODE_LOCATIONS[id]?.name,
    online:   nodeStatus[id].online,
    readings: nodeStatus[id].totalReadings,
  })),
}));

// ── WebSocket — send full state on connect ──
wss.on('connection', ws => {
  console.log('Dashboard connected');
  ws.send(JSON.stringify({ type: 'init', ...buildState() }));
  ws.on('close', () => console.log('Dashboard disconnected'));
});

// ── Periodic offline detection + broadcast ──
setInterval(() => {
  const now = Date.now();
  Object.keys(nodeStatus).forEach(id => {
    const wasOnline = nodeStatus[id].online;
    nodeStatus[id].online = !!(nodeStatus[id].lastSeen &&
      now - nodeStatus[id].lastSeen < OFFLINE_AFTER_MS);
    if (wasOnline && !nodeStatus[id].online) {
      console.log(`[${id}] went OFFLINE`);
      wss.clients.forEach(c => {
        if (c.readyState === 1)
          c.send(JSON.stringify({ type: 'status', node_id: id, online: false }));
      });
    }
  });
}, 5000);

server.listen(PORT,() => {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  EnviroNet Server (Location-Aware) :' + PORT);
  console.log('═══════════════════════════════════════════');
  console.log('  Dashboard : http://localhost:' + PORT);
  console.log('  State API : http://localhost:' + PORT + '/api/state');
  console.log('  Nearest   : http://localhost:' + PORT + '/api/nearest?lat=0&lng=0');
  console.log('  Health    : http://localhost:' + PORT + '/api/health');
  console.log('  Waiting for ESP32 nodes…\n');
});
