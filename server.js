const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const multer = require("multer");
const slugify = require("slugify");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data", "projects.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me";
const STAGE_WIDTH = parseInt(process.env.STAGE_WIDTH || "1100", 10);
const STAGE_HEIGHT = parseInt(process.env.STAGE_HEIGHT || "700", 10);

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { sameSite: "lax" }
}));

// Static
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Views
app.get("/", (req,res)=> res.sendFile(path.join(__dirname, "views", "index.html")));
app.get("/project.html", (req,res)=> res.sendFile(path.join(__dirname, "views", "project.html")));
app.get("/bibliography.html", (req,res)=> res.sendFile(path.join(__dirname, "views", "bibliography.html")));
app.get("/admin/login.html", (req,res)=> res.sendFile(path.join(__dirname, "admin", "login.html")));
app.get("/admin/dashboard.html", (req,res)=> {
  if (!req.session || !req.session.auth) return res.redirect("/admin/login.html");
  res.sendFile(path.join(__dirname, "admin", "dashboard.html"));
});

// Helpers
function readProjects(){
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}
function writeProjects(list){
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}
function ensureUploadsDir(projectId){
  const dir = path.join(UPLOADS_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- Public API ----------
app.get("/api/projects", (req, res) => {
  const projects = readProjects();
  res.json(projects.map(p => ({ id: p.id, name: p.name, description: p.description, images: p.images })));
});

app.get("/api/project/:id", (req, res) => {
  const projects = readProjects();
  const p = projects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json({ ...p, stage: { width: STAGE_WIDTH, height: STAGE_HEIGHT } });
});

// ---------- Admin auth ----------
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if ((username || "") === (process.env.ADMIN_USER || "admin") &&
      (password || "") === (process.env.ADMIN_PASS || "change-me")) {
    req.session.auth = { user: username, at: Date.now() };
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(()=> res.json({ ok: true }));
});

function requireAdmin(req, res, next){
  if (req.session && req.session.auth) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ---------- Admin API (CRUD) ----------
app.get("/api/admin/projects", requireAdmin, (req,res) => {
  res.json(readProjects());
});

app.post("/api/admin/projects", requireAdmin, (req,res) => {
  let { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const id = slugify(name, { lower: true, strict: true }) || ("project-" + Date.now());
  const projects = readProjects();
  if (projects.some(p => p.id === id)) return res.status(400).json({ error: "project id exists" });
  const proj = { id, name, description: description || "", images: [] };
  projects.push(proj);
  writeProjects(projects);
  ensureUploadsDir(id);
  res.json(proj);
});

app.put("/api/admin/projects/:id", requireAdmin, (req,res) => {
  const { id } = req.params;
  const { name, description } = req.body || {};
  const projects = readProjects();
  const p = projects.find(x => x.id === id);
  if (!p) return res.status(404).json({ error: "not found" });
  if (name) p.name = name;
  if (typeof description === "string") p.description = description;
  writeProjects(projects);
  res.json(p);
});

app.delete("/api/admin/projects/:id", requireAdmin, (req,res) => {
  const { id } = req.params;
  const projects = readProjects();
  const idx = projects.findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  projects.splice(idx, 1);
  writeProjects(projects);
  const dir = path.join(UPLOADS_DIR, id);
  fs.rm(dir, { recursive: true, force: true }, ()=> res.json({ ok: true }));
});

// Reorder projects
app.put("/api/admin/projects/reorder", requireAdmin, (req,res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: "order must be array of project ids" });
  const projects = readProjects();
  const projectMap = new Map(projects.map(p => [p.id, p]));
  
  // Reorder projects based on the order array, keeping only existing projects
  const reorderedProjects = order
    .filter(id => projectMap.has(id))
    .map(id => projectMap.get(id));
  
  // Add any projects that weren't in the order array at the end
  const remainingProjects = projects.filter(p => !order.includes(p.id));
  const finalProjects = [...reorderedProjects, ...remainingProjects];
  
  writeProjects(finalProjects);
  res.json({ ok: true, projects: finalProjects });
});

// Uploads
const storage = multer.diskStorage({
  destination: function(req, file, cb){
    const dir = ensureUploadsDir(req.params.id);
    cb(null, dir);
  },
  filename: function(req, file, cb){
    const safe = path.basename(file.originalname).replace(/[^\w.\-]+/g, "_");
    cb(null, Date.now() + "_" + safe);
  }
});
const upload = multer({ storage });

app.post("/api/admin/upload/:id", requireAdmin, upload.array("images", 100), (req, res) => {
  const { id } = req.params;
  const projects = readProjects();
  const p = projects.find(x => x.id === id);
  if (!p) return res.status(404).json({ error: "not found" });
  const files = (req.files || []).map(f => "uploads/" + id + "/" + path.basename(f.filename));
  p.images.push(...files);
  writeProjects(projects);
  res.json({ ok: true, added: files.length, images: p.images });
});

// Reorder images
app.put("/api/admin/reorder/:id", requireAdmin, (req,res) => {
  const { id } = req.params;
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: "order must be array of image paths" });
  const projects = readProjects();
  const p = projects.find(x => x.id === id);
  if (!p) return res.status(404).json({ error: "not found" });
  // keep only images that exist in current set, in the new order
  const set = new Set(p.images);
  const newOrder = order.filter(x => set.has(x));
  // append any that were missing from order at the end
  p.images = newOrder.concat(p.images.filter(x => !newOrder.includes(x)));
  writeProjects(projects);
  res.json({ ok: true, images: p.images });
});

// Delete single image
app.delete("/api/admin/image/:id", requireAdmin, (req,res) => {
  const { id } = req.params;
  const { filename } = req.body || {};
  if (!filename) return res.status(400).json({ error: "filename required" });
  const projects = readProjects();
  const p = projects.find(x => x.id === id);
  if (!p) return res.status(404).json({ error: "not found" });
  p.images = p.images.filter(x => x !== filename);
  writeProjects(projects);
  const filePath = path.join(__dirname, filename);
  fs.unlink(filePath, ()=> res.json({ ok: true }));
});

app.listen(PORT, () => console.log(`Portfolio running at http://127.0.0.1:${PORT}`));
