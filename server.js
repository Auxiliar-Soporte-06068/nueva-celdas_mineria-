// --- server.js ---
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const shapefile = require("shapefile");
const AdmZip = require("adm-zip");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = 3000;

// Estado global de las celdas
let estadoCeldas = {
  todas: [],
  ocupadas: [],
  libres: [],
};

// Cache de features y bounding boxes del shapefile
let featuresCache = [];
let bboxCache = {}; // { CELDA: [minX, minY, maxX, maxY] }

// Función para leer shapefile desde ZIP
async function leerShapefileZip(rutaZip) {
  const zip = new AdmZip(rutaZip);
  const tempDir = path.join(__dirname, "temp_shp");

  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  // Limpia tempDir
  fs.readdirSync(tempDir).forEach((f) => fs.unlinkSync(path.join(tempDir, f)));

  zip.extractAllTo(tempDir, true);

  const shpFile = fs.readdirSync(tempDir).find((f) => f.endsWith(".shp"));
  const dbfFile = shpFile.replace(".shp", ".dbf");

  const features = [];
  await shapefile
    .open(path.join(tempDir, shpFile), path.join(tempDir, dbfFile))
    .then((source) =>
      source.read().then(function leer(result) {
        if (result.done) return;
        features.push(result.value);
        return source.read().then(leer);
      })
    );

  return features;
}

// Precalcular bounding boxes al cargar shapefile
function calcularBoundingBoxes(features) {
  const cache = {};
  features.forEach((f) => {
    const celda = f.properties?.CELL_KEY_I?.trim();
    if (!celda || !f.geometry) return;

    const coords = f.geometry.coordinates.flat(Infinity);
    const xs = coords.filter((_, i) => i % 2 === 0);
    const ys = coords.filter((_, i) => i % 2 === 1);
    cache[celda] = [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ];
  });
  return cache;
}

// Función para detectar grupos usando bounding boxes precalculadas
function detectarGruposLibresSeparados(celdasLibres) {
  const grupos = [];
  const visitadas = new Set();

  function intersecta(celdaA, celdaB) {
    const [minAx, minAy, maxAx, maxAy] = bboxCache[celdaA];
    const [minBx, minBy, maxBx, maxBy] = bboxCache[celdaB];
    return !(minAx > maxBx || maxAx < minBx || minAy > maxBy || maxAy < minBy);
  }

  for (const celda of celdasLibres) {
    if (visitadas.has(celda) || !bboxCache[celda]) continue;

    const grupo = [];
    const cola = [celda];
    visitadas.add(celda);

    while (cola.length) {
      const actual = cola.pop();
      grupo.push(actual);

      for (const otra of celdasLibres) {
        if (visitadas.has(otra) || !bboxCache[otra]) continue;
        if (intersecta(actual, otra)) {
          cola.push(otra);
          visitadas.add(otra);
        }
      }
    }

    grupos.push(grupo);
  }

  return grupos.length > 0 ? grupos : [];
}

// Función interna para actualizar celdas
function actualizarCeldas(celdasOcupadas) {
  if (!featuresCache.length) throw new Error("Shapefile no cargado");

  const todasCeldas = featuresCache
    .map((f) => f.properties?.CELL_KEY_I?.trim())
    .filter((c) => c);

  const ocupadas = Array.isArray(celdasOcupadas) ? celdasOcupadas : [];
  const libres = todasCeldas.filter((c) => !ocupadas.includes(c));

  estadoCeldas = { todas: todasCeldas, ocupadas, libres };

  const grupos = detectarGruposLibresSeparados(libres);

  const Areas = grupos.map((grupo) => ({
    NombreArea: `509188`,
    Referencia: grupo[0],
    Celdas: [grupo.join(", ")],
  }));

  io.emit("actualizacion-celdas", estadoCeldas);

  return Areas;
}

// Cargar shapefile al iniciar el servidor
(async () => {
  try {
    const dataDir = path.join(__dirname, "data");
    const files = fs
      .readdirSync(dataDir)
      .filter((f) => f.toLowerCase().endsWith(".zip"));
    if (!files.length) throw new Error("No hay shapefile en /data");
    featuresCache = await leerShapefileZip(path.join(dataDir, files[0]));
    bboxCache = calcularBoundingBoxes(featuresCache);
    console.log("Shapefile cargado y bounding boxes precalculadas.");
  } catch (err) {
    console.error("Error cargando shapefile:", err);
  }
})();

// Conexión socket.io
io.on("connection", (socket) => {
  console.log("Cliente conectado (socket)");
  socket.emit("actualizacion-celdas", estadoCeldas);

  // Permitir actualizar celdas desde el cliente
  socket.on("actualizar-celdas", (celdasOcupadas) => {
    try {
      const Areas = actualizarCeldas(celdasOcupadas);
      socket.emit("areas-actualizadas", Areas);
    } catch (err) {
      console.error(err);
      socket.emit("error", { message: err.message });
    }
  });
});

// Servir HTML estático
app.use(express.static(__dirname));

// Exponer funciones internas para uso interno si quieres
module.exports = { actualizarCeldas, estadoCeldas, featuresCache, bboxCache };

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
