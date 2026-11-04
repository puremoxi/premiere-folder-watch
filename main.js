const { entrypoints } = require("uxp");
const { localFileSystem } = require("uxp").storage;
const ppro = require("premierepro");
const core = require("./watch-core.js");

const CONFIG_KEY = "folderWatch.config.v2";
const PROJECT_KEY_PREFIX = "folderWatch.project.v2.";
const MAX_ACTIVITY_ITEMS = 60;
const MAX_DISCOVERED_FOLDERS = 500;

const DEFAULT_CONFIG = Object.freeze({
  autoSync: false,
  pollIntervalMs: 2500,
  stablePollsRequired: 2,
  extensions: [...core.DEFAULT_MEDIA_EXTENSIONS],
  ignoredFolders: [...core.DEFAULT_IGNORED_FOLDERS],
  showImportDialogs: false,
  notifications: true
});

const runtime = {
  initialized: false,
  visible: false,
  project: null,
  projectGuid: null,
  projectName: null,
  projectPath: null,
  watchFolders: [],
  folderEntries: new Map(),
  observations: new Map(),
  timer: null,
  syncing: false,
  config: loadConfig(),
  activity: [],
  editor: null,
  projectEventHandler: null,
  projectRefreshPending: false,
  totals: { imported: 0, pending: 0, issues: 0 }
};

const $ = (id) => document.getElementById(id);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseJSON(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function loadConfig() {
  const stored = parseJSON(localStorage.getItem(CONFIG_KEY), {});
  return {
    autoSync: Boolean(stored.autoSync),
    pollIntervalMs: clampNumber(stored.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs, 1000, 60000),
    stablePollsRequired: clampNumber(stored.stablePollsRequired, DEFAULT_CONFIG.stablePollsRequired, 0, 20),
    extensions: Array.isArray(stored.extensions) && stored.extensions.length
      ? stored.extensions.map((value) => String(value).replace(/^\./, "").toLowerCase()).filter(Boolean)
      : [...DEFAULT_CONFIG.extensions],
    ignoredFolders: Array.isArray(stored.ignoredFolders)
      ? stored.ignoredFolders.map(String).filter(Boolean)
      : [...DEFAULT_CONFIG.ignoredFolders],
    showImportDialogs: Boolean(stored.showImportDialogs),
    notifications: stored.notifications !== false
  };
}

function saveConfig() {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(runtime.config));
}

function projectStorageKey(projectGuid) {
  return `${PROJECT_KEY_PREFIX}${projectGuid}`;
}

function cleanRegistry(registry) {
  const value = registry || {};
  return {
    paths: Array.isArray(value.paths) ? value.paths.map(String) : [],
    sequences: value.sequences && typeof value.sequences === "object" ? value.sequences : {}
  };
}

function cleanWatchFolder(watch) {
  const settings = core.sanitizeWatchSettings(watch.settings || {});
  return {
    id: String(watch.id),
    name: String(watch.name || core.fileNameOf(watch.nativePath) || "Watch folder"),
    nativePath: String(watch.nativePath || ""),
    token: String(watch.token || ""),
    relative: Boolean(watch.relative),
    relativePath: watch.relativePath ? String(watch.relativePath) : null,
    targetBinPath: Array.isArray(watch.targetBinPath) ? watch.targetBinPath.map(String) : [],
    settings,
    overrides: watch.overrides && typeof watch.overrides === "object" ? watch.overrides : {},
    baselinePending: Boolean(watch.baselinePending),
    registry: cleanRegistry(watch.registry),
    discoveredFolders: Array.isArray(watch.discoveredFolders)
      ? watch.discoveredFolders.map(String).slice(0, MAX_DISCOVERED_FOLDERS)
      : [],
    lastStatus: watch.lastStatus || "idle",
    lastMessage: watch.lastMessage || "Ready to sync",
    importedCount: Number(watch.importedCount) || 0,
    pendingCount: 0,
    issueCount: 0,
    lastSyncedAt: watch.lastSyncedAt || null
  };
}

function loadProjectState(projectGuid) {
  const stored = parseJSON(localStorage.getItem(projectStorageKey(projectGuid)), { watchFolders: [] });
  return Array.isArray(stored.watchFolders) ? stored.watchFolders.map(cleanWatchFolder) : [];
}

function persistedWatch(watch) {
  return {
    id: watch.id,
    name: watch.name,
    nativePath: watch.nativePath,
    token: watch.token,
    relative: watch.relative,
    relativePath: watch.relativePath,
    targetBinPath: watch.targetBinPath,
    settings: watch.settings,
    overrides: watch.overrides,
    baselinePending: watch.baselinePending,
    registry: watch.registry,
    discoveredFolders: watch.discoveredFolders,
    lastStatus: watch.lastStatus,
    lastMessage: watch.lastMessage,
    importedCount: watch.importedCount,
    lastSyncedAt: watch.lastSyncedAt
  };
}

function saveProjectState() {
  if (!runtime.projectGuid) throw new Error("Open a Premiere project before saving a watch folder");
  core.persistJSON(
    localStorage,
    projectStorageKey(runtime.projectGuid),
    { watchFolders: runtime.watchFolders.map(persistedWatch) }
  );
}

function escapeHTML(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function displayTime(value = new Date()) {
  try {
    return value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (_) {
    return "now";
  }
}

function addActivity(message, kind = "neutral", force = false) {
  if (!runtime.config.notifications && !force && kind !== "error") return;
  runtime.activity.unshift({ message: String(message), kind, time: displayTime() });
  runtime.activity = runtime.activity.slice(0, MAX_ACTIVITY_ITEMS);
  renderActivity();
}

function renderActivity() {
  const log = $("activityLog");
  if (!log) return;
  if (runtime.activity.length === 0) {
    log.innerHTML = '<p class="activity-empty">No sync activity yet.</p>';
    return;
  }
  log.innerHTML = runtime.activity.map((item) => `
    <div class="activity-item ${escapeHTML(item.kind)}">
      <span class="activity-dot" aria-hidden="true"></span>
      <span class="activity-message">${escapeHTML(item.message)}</span>
      <span class="activity-time">${escapeHTML(item.time)}</span>
    </div>
  `).join("");
}

async function projectValue(project, property, getter) {
  if (project && project[property] !== undefined && project[property] !== null) return project[property];
  if (project && getter && typeof project[getter] === "function") return project[getter]();
  return null;
}

async function getProjectInfo() {
  const project = await ppro.Project.getActiveProject();
  if (!project) return null;
  const name = await projectValue(project, "name", "getName") || "Untitled project";
  const path = await projectValue(project, "path", "getPath") || "";
  const guid = await projectValue(project, "guid", "getGuid")
    || await projectValue(project, "documentID", "getDocumentID")
    || path
    || name;
  return { project, name: String(name), path: String(path || ""), guid: String(guid) };
}

async function refreshActiveProject() {
  let info;
  try {
    info = await getProjectInfo();
  } catch (error) {
    setProjectError(`Premiere connection failed: ${error.message}`);
    return false;
  }

  if (!info) {
    runtime.project = null;
    runtime.projectGuid = null;
    runtime.projectName = null;
    runtime.projectPath = null;
    runtime.watchFolders = [];
    runtime.folderEntries.clear();
    setProjectError("Open a Premiere project to use Folder Watch");
    render();
    return false;
  }

  if (runtime.projectGuid !== info.guid) {
    runtime.project = info.project;
    runtime.projectGuid = info.guid;
    runtime.projectName = info.name;
    runtime.projectPath = info.path;
    runtime.watchFolders = loadProjectState(info.guid);
    runtime.folderEntries.clear();
    runtime.observations.clear();
    runtime.totals = { imported: 0, pending: 0, issues: 0 };
    addActivity(`Loaded watch settings for ${info.name}`, "neutral", true);
  } else {
    runtime.project = info.project;
    runtime.projectName = info.name;
    runtime.projectPath = info.path;
  }

  $("projectBanner").classList.remove("error");
  $("projectName").textContent = runtime.projectName;
  render();
  return true;
}

function setProjectError(message) {
  const banner = $("projectBanner");
  if (!banner) return;
  banner.classList.add("error");
  $("projectName").textContent = message;
}

function restartTimer() {
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  if (!runtime.config.autoSync) return;
  runtime.timer = setInterval(() => {
    syncAll("automatic");
  }, runtime.config.pollIntervalMs);
}

function setAutoSync(enabled) {
  runtime.config.autoSync = Boolean(enabled);
  saveConfig();
  restartTimer();
  renderToolbar();
  addActivity(enabled ? "Automatic sync started" : "Automatic sync paused", enabled ? "ok" : "neutral", true);
  if (enabled) syncAll("automatic");
}

function renderToolbar() {
  if (!$("toggleWatching")) return;
  $("toggleWatching").classList.toggle("watching", runtime.config.autoSync);
  $("toggleWatchingLabel").textContent = runtime.config.autoSync ? "Pause auto-sync" : "Start auto-sync";
  $("watchLight").classList.toggle("on", runtime.config.autoSync);
  $("watchLight").setAttribute(
    "aria-label",
    runtime.config.autoSync ? "Automatic sync is on" : "Automatic sync is off"
  );
  $("syncNow").disabled = runtime.syncing || !runtime.projectGuid || runtime.watchFolders.length === 0;
  $("syncNow").classList.toggle("syncing", runtime.syncing);
  $("addFolder").disabled = !runtime.projectGuid;
  $("emptyAddFolder").disabled = !runtime.projectGuid;
}

function folderFlags(watch) {
  const flags = [];
  if (watch.settings.includeSubfolders) flags.push("Subfolders");
  if (watch.settings.flatten) flags.push("Flattened");
  else flags.push("Bin hierarchy");
  if (watch.settings.imageSequences !== "off") flags.push("Sequences");
  if (watch.relative) flags.push("Relative path");
  if (watch.settings.duplicateScan) flags.push("Duplicate scan");
  return flags;
}

function renderWatchList() {
  const list = $("watchList");
  $("emptyState").hidden = runtime.watchFolders.length > 0;
  if (runtime.watchFolders.length === 0) {
    list.innerHTML = "";
    return;
  }

  list.innerHTML = runtime.watchFolders.map((watch) => {
    const statusClass = watch.lastStatus === "error"
      ? "error"
      : watch.pendingCount > 0
        ? "pending"
        : watch.lastStatus === "ok"
          ? "ok"
          : "";
    const target = watch.targetBinPath.length ? watch.targetBinPath.join(" / ") : "Project root";
    return `
      <article class="watch-card${watch.issueCount ? " issue" : ""}" data-watch-id="${escapeHTML(watch.id)}">
        <header>
          <span class="folder-glyph" aria-hidden="true"></span>
          <div class="identity">
            <h3>${escapeHTML(watch.name)}</h3>
            <p class="path" title="${escapeHTML(watch.nativePath)}">${escapeHTML(watch.nativePath)}</p>
          </div>
          <span class="card-status ${statusClass}" title="${escapeHTML(watch.lastMessage)}"></span>
        </header>
        <div class="card-meta">
          <span>Premiere bin</span><span title="${escapeHTML(target)}">${escapeHTML(target)}</span>
          <span>Status</span><span>${escapeHTML(watch.lastMessage)}</span>
        </div>
        <div class="card-flags">
          ${folderFlags(watch).map((flag, index) => `<span class="flag${index === 0 ? " accent" : ""}">${escapeHTML(flag)}</span>`).join("")}
        </div>
        <div class="card-actions">
          <button type="button" data-action="sync" data-id="${escapeHTML(watch.id)}">Sync</button>
          <button type="button" data-action="selected-bin" data-id="${escapeHTML(watch.id)}">Selected bin</button>
          <button type="button" data-action="settings" data-id="${escapeHTML(watch.id)}">Settings</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderSummary() {
  const imported = runtime.watchFolders.reduce((total, watch) => total + watch.importedCount, 0);
  const pending = runtime.watchFolders.reduce((total, watch) => total + watch.pendingCount, 0);
  const issues = runtime.watchFolders.reduce((total, watch) => total + watch.issueCount, 0);
  $("folderCount").textContent = String(runtime.watchFolders.length);
  $("importedCount").textContent = String(imported);
  $("pendingCount").textContent = String(pending);
  $("issueCount").textContent = String(issues);
}

function renderSettings() {
  $("extensions").value = runtime.config.extensions.join(", ");
  $("ignoredFolders").value = runtime.config.ignoredFolders.join("\n");
  $("pollInterval").value = String(runtime.config.pollIntervalMs);
  $("stablePolls").value = String(runtime.config.stablePollsRequired);
  $("showImportDialogs").checked = runtime.config.showImportDialogs;
  $("notifications").checked = runtime.config.notifications;
}

function render() {
  if (!runtime.initialized) return;
  renderToolbar();
  renderSummary();
  renderWatchList();
  renderActivity();
}

function settingsFromControls() {
  return core.sanitizeWatchSettings({
    importExisting: $("editImportExisting").checked,
    includeSubfolders: $("editIncludeSubfolders").checked,
    flatten: $("editFlatten").checked,
    autoFlattenCameraFolders: $("editAutoCamera").checked,
    imageSequences: $("editSequences").value,
    labelIndex: $("editLabel").value,
    duplicateScan: $("editDuplicateScan").checked
  });
}

function setControlsFromSettings(settings) {
  const clean = core.sanitizeWatchSettings(settings);
  $("editImportExisting").checked = clean.importExisting;
  $("editIncludeSubfolders").checked = clean.includeSubfolders;
  $("editFlatten").checked = clean.flatten;
  $("editAutoCamera").checked = clean.autoFlattenCameraFolders;
  $("editSequences").value = clean.imageSequences;
  $("editLabel").value = clean.labelIndex === null ? "" : String(clean.labelIndex);
  $("editDuplicateScan").checked = clean.duplicateScan;
}

function effectiveEditorSettings(path) {
  const draft = runtime.editor.draft;
  return path
    ? core.resolveFolderSettings(draft.settings, draft.overrides, path)
    : core.sanitizeWatchSettings(draft.settings);
}

function storeEditorControls() {
  if (!runtime.editor) return;
  const path = runtime.editor.overridePath;
  const settings = settingsFromControls();
  if (path) {
    const overrides = { ...runtime.editor.draft.overrides };
    delete overrides[path];
    const inherited = core.resolveFolderSettings(
      runtime.editor.draft.settings,
      overrides,
      core.dirnameOf(path)
    );
    const changes = {};
    for (const key of [
      "includeSubfolders", "flatten", "autoFlattenCameraFolders", "imageSequences", "labelIndex"
    ]) {
      if (settings[key] !== inherited[key]) changes[key] = settings[key];
    }
    if (Object.keys(changes).length) runtime.editor.draft.overrides[path] = changes;
    else delete runtime.editor.draft.overrides[path];
  } else {
    runtime.editor.draft.settings = settings;
  }
  runtime.editor.draft.relative = $("editRelative").checked;
}

function loadEditorControls(path) {
  runtime.editor.overridePath = path;
  setControlsFromSettings(effectiveEditorSettings(path));
  $("editRelative").checked = runtime.editor.draft.relative;
  $("editRelative").disabled = Boolean(path);
  $("editDuplicateScan").disabled = Boolean(path);
  $("editImportExistingRow").hidden = !runtime.editor.isNew || Boolean(path);
}

function renderOverridePicker() {
  const draft = runtime.editor.draft;
  const paths = Array.from(new Set([
    ...(draft.discoveredFolders || []),
    ...Object.keys(draft.overrides || {})
  ])).filter(Boolean).sort((a, b) => a.localeCompare(b));
  $("overridePath").innerHTML = [
    '<option value="">Watch folder root</option>',
    ...paths.map((path) => {
      const depth = core.splitRelativePath(path).length;
      const indent = "· ".repeat(Math.max(0, depth - 1));
      const overridden = draft.overrides[path] ? " *" : "";
      return `<option value="${escapeHTML(path)}">${escapeHTML(`${indent}${core.fileNameOf(path)}${overridden}`)}</option>`;
    })
  ].join("");
  $("overridePath").value = runtime.editor.overridePath || "";
}

function openEditor(watch, isNew = false) {
  runtime.editor = {
    originalId: isNew ? null : watch.id,
    isNew,
    draft: clone(watch),
    overridePath: ""
  };
  $("editorTitle").textContent = watch.name;
  $("editorPath").textContent = watch.nativePath;
  $("editorTargetBin").textContent = watch.targetBinPath.length
    ? watch.targetBinPath.join(" / ")
    : "Project root";
  renderOverridePicker();
  loadEditorControls("");
  $("editorBackdrop").hidden = false;
}

function closeEditor() {
  runtime.editor = null;
  $("editorBackdrop").hidden = true;
}

async function getRootItem(project = runtime.project) {
  if (!project || typeof project.getRootItem !== "function") throw new Error("Premiere project tree is unavailable");
  return project.getRootItem();
}

async function getChildren(item) {
  // Plain ProjectItems from getItems() have no getItems(); cast bins to FolderItem first.
  let folder = item;
  if (item && typeof item.getItems !== "function") {
    try {
      folder = asFolderItem(item);
    } catch (_) {
      folder = null;
    }
  }
  return folder && typeof folder.getItems === "function" ? folder.getItems() : [];
}

function itemName(item) {
  return String(item && (item.name || item.displayName) || "");
}

function itemIdentity(item) {
  if (!item) return "";
  if (typeof item.getId === "function") return String(item.getId());
  return String(item.guid || item.nodeId || item.id || item.treePath || "");
}

function isFolderItem(item) {
  if (!item) return false;
  const type = item.type;
  const projectItem = ppro.ProjectItem;
  if (projectItem && (type === projectItem.TYPE_BIN || type === projectItem.TYPE_ROOT)) return true;
  return typeof item.getItems === "function" && typeof item.getMediaFilePath !== "function";
}

async function findPathToItem(root, target, path = []) {
  const targetId = itemIdentity(target);
  const rootId = itemIdentity(root);
  if (root === target || (targetId && rootId === targetId)) return path;
  for (const child of await getChildren(root)) {
    if (!isFolderItem(child)) continue;
    const childPath = [...path, itemName(child)];
    const childId = itemIdentity(child);
    if (child === target || (targetId && childId === targetId)) return childPath;
    const nested = await findPathToItem(child, target, childPath);
    if (nested) return nested;
  }
  return null;
}

async function selectedBinDescriptor() {
  if (!runtime.project) throw new Error("Open a Premiere project first");
  let selected = [];
  if (ppro.ProjectUtils && typeof ppro.ProjectUtils.getSelection === "function") {
    try {
      const selection = await ppro.ProjectUtils.getSelection(runtime.project);
      selected = selection && typeof selection.getItems === "function"
        ? await selection.getItems()
        : [];
    } catch (_) {
      selected = [];
    }
  }
  let bin = selected.find(isFolderItem);
  if (!bin && typeof runtime.project.getInsertionBin === "function") {
    bin = await runtime.project.getInsertionBin();
  }
  const root = await getRootItem();
  if (!bin || bin === root) return { bin: root, path: [] };
  const path = await findPathToItem(root, bin);
  if (!path) throw new Error("Select a bin in Premiere's Project panel and try again");
  return { bin, path };
}

async function addFolder() {
  if (!await refreshActiveProject()) return;
  try {
    const folder = await localFileSystem.getFolder();
    if (!folder) return;
    const token = await localFileSystem.createPersistentToken(folder);
    const target = await selectedBinDescriptor();
    const nativePath = folder.nativePath;
    const watch = cleanWatchFolder({
      id: core.watchFolderId(runtime.projectGuid, nativePath),
      name: folder.name || core.fileNameOf(nativePath),
      nativePath,
      token,
      targetBinPath: target.path,
      settings: core.DEFAULT_WATCH_SETTINGS,
      overrides: {},
      baselinePending: false,
      registry: { paths: [], sequences: {} },
      discoveredFolders: []
    });
    runtime.folderEntries.set(watch.id, folder);
    openEditor(watch, true);
  } catch (error) {
    addActivity(`Could not add folder: ${error.message}`, "error", true);
  }
}

async function findDiskFolder(root, relativePath) {
  let current = root;
  for (const segment of core.splitRelativePath(relativePath)) {
    const entries = await current.getEntries();
    const next = entries.find((entry) => entry.isFolder && entry.name === segment);
    if (!next) throw new Error(`Folder is unavailable: ${relativePath}`);
    current = next;
  }
  return current;
}

async function createEditorChildFolder() {
  if (!runtime.editor) return;
  const name = $("newChildFolderName").value.trim();
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
    addActivity("Enter a folder name without slashes", "warning", true);
    return;
  }
  try {
    storeEditorControls();
    const root = await restoreWatchEntry(runtime.editor.draft);
    const parentPath = runtime.editor.overridePath;
    const parent = await findDiskFolder(root, parentPath);
    if (typeof parent.createFolder !== "function") throw new Error("This UXP version cannot create folders");
    await parent.createFolder(name);
    const relativePath = parentPath ? `${parentPath}/${name}` : name;
    runtime.editor.draft.discoveredFolders = Array.from(new Set([
      ...(runtime.editor.draft.discoveredFolders || []),
      relativePath
    ])).sort((a, b) => a.localeCompare(b));
    runtime.editor.overridePath = relativePath;
    $("newChildFolderName").value = "";
    renderOverridePicker();
    loadEditorControls(relativePath);
    addActivity(`Created ${relativePath} on disk`, "ok", true);
  } catch (error) {
    addActivity(`Could not create folder: ${error.message}`, "error", true);
  }
}

async function relinkEditorFolder() {
  if (!runtime.editor) return;
  try {
    const folder = await localFileSystem.getFolder();
    if (!folder) return;
    runtime.editor.draft.nativePath = folder.nativePath;
    runtime.editor.draft.name = folder.name || core.fileNameOf(folder.nativePath);
    runtime.editor.draft.token = await localFileSystem.createPersistentToken(folder);
    runtime.editor.draft.relativePath = null;
    runtime.folderEntries.set(runtime.editor.draft.id, folder);
    $("editorTitle").textContent = runtime.editor.draft.name;
    $("editorPath").textContent = runtime.editor.draft.nativePath;
  } catch (error) {
    addActivity(`Could not relink folder: ${error.message}`, "error", true);
  }
}

async function setEditorSelectedBin() {
  if (!runtime.editor) return;
  try {
    const target = await selectedBinDescriptor();
    runtime.editor.draft.targetBinPath = target.path;
    $("editorTargetBin").textContent = target.path.join(" / ") || "Project root";
    addActivity(`Destination set to ${target.path.join(" / ") || "Project root"}`, "ok", true);
  } catch (error) {
    addActivity(error.message, "error", true);
  }
}

function projectDirectory() {
  return runtime.projectPath ? core.dirnameOf(runtime.projectPath) : "";
}

function computeRelativePath(watch) {
  const base = projectDirectory();
  if (!base) return null;
  return core.relativePathBetween(base, watch.nativePath);
}

function saveEditor() {
  if (!runtime.editor) return;
  storeEditorControls();
  const draft = cleanWatchFolder(runtime.editor.draft);
  const previousWatchFolders = clone(runtime.watchFolders);

  if (draft.relative) {
    const relativePath = computeRelativePath(draft);
    if (!relativePath) {
      $("editRelative").checked = false;
      draft.relative = false;
      draft.relativePath = null;
      addActivity("Relative paths require a saved project on the same drive", "warning", true);
    } else {
      draft.relativePath = relativePath;
    }
  } else {
    draft.relativePath = null;
  }

  const duplicateWatch = runtime.watchFolders.some((watch) => (
    watch.id !== runtime.editor.originalId
    && core.pathKey(watch.nativePath) === core.pathKey(draft.nativePath)
  ));
  if (duplicateWatch) {
    addActivity("That folder is already being watched in this project", "warning", true);
    return;
  }

  if (runtime.editor.isNew) {
    draft.baselinePending = !draft.settings.importExisting;
    runtime.watchFolders.push(draft);
  } else {
    const index = runtime.watchFolders.findIndex((watch) => watch.id === runtime.editor.originalId);
    if (index >= 0) runtime.watchFolders[index] = draft;
  }

  try {
    saveProjectState();
  } catch (error) {
    runtime.watchFolders = previousWatchFolders;
    addActivity(`Could not save ${draft.name}: ${error.message}`, "error", true);
    render();
    return;
  }
  addActivity(
    runtime.editor.isNew ? `Added ${draft.name}` : `Saved settings for ${draft.name}`,
    "ok",
    true
  );
  closeEditor();
  render();
  if (runtime.config.autoSync) syncAll("automatic");
}

function removeEditorFolder() {
  if (!runtime.editor || runtime.editor.isNew) {
    closeEditor();
    return;
  }
  const id = runtime.editor.originalId;
  const watch = runtime.watchFolders.find((item) => item.id === id);
  runtime.watchFolders = runtime.watchFolders.filter((item) => item.id !== id);
  runtime.folderEntries.delete(id);
  for (const key of runtime.observations.keys()) {
    if (key.startsWith(`${id}\x00`)) runtime.observations.delete(key);
  }
  saveProjectState();
  closeEditor();
  addActivity(`Removed ${watch ? watch.name : "watch folder"}. Source files were not changed.`, "neutral", true);
  render();
}

async function updateWatchSelectedBin(id) {
  const watch = runtime.watchFolders.find((item) => item.id === id);
  if (!watch) return;
  try {
    const target = await selectedBinDescriptor();
    watch.targetBinPath = target.path;
    saveProjectState();
    addActivity(`${watch.name} now imports to ${target.path.join(" / ") || "Project root"}`, "ok", true);
    render();
  } catch (error) {
    addActivity(error.message, "error", true);
  }
}

async function restoreWatchEntry(watch) {
  if (runtime.folderEntries.has(watch.id)) return runtime.folderEntries.get(watch.id);
  try {
    const entry = await localFileSystem.getEntryForPersistentToken(watch.token);
    if (!entry || !entry.isFolder) throw new Error("Saved location is not a folder");
    runtime.folderEntries.set(watch.id, entry);
    if (entry.nativePath && entry.nativePath !== watch.nativePath) watch.nativePath = entry.nativePath;
    return entry;
  } catch (tokenError) {
    if (watch.relative && watch.relativePath && projectDirectory() && typeof localFileSystem.getEntryWithUrl === "function") {
      try {
        const absolute = core.resolveRelativePath(projectDirectory(), watch.relativePath);
        const url = absolute.startsWith("file:") ? absolute : `file:${absolute}`;
        const entry = await localFileSystem.getEntryWithUrl(url);
        if (entry && entry.isFolder) {
          runtime.folderEntries.set(watch.id, entry);
          watch.nativePath = entry.nativePath || absolute;
          watch.token = await localFileSystem.createPersistentToken(entry);
          return entry;
        }
      } catch (_) {
        // Fall through to the actionable relink error below.
      }
    }
    throw new Error("Folder permission expired. Open Settings and choose Relink folder.");
  }
}

async function walkFolder(folder, watch) {
  const files = [];
  const discoveredFolders = [];
  const ignoredRules = runtime.config.ignoredFolders;
  const importedPaths = registrySet(watch);
  const visitedFolders = new Set();

  async function visit(current, relativeDirectory) {
    const folderKey = core.pathKey(current.nativePath || relativeDirectory || watch.nativePath);
    if (visitedFolders.has(folderKey)) return;
    visitedFolders.add(folderKey);
    const entries = await current.getEntries();
    for (const entry of entries) {
      if (entry.isFolder) {
        const childRelative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        if (core.shouldIgnoreFolder(entry.name, ignoredRules)) continue;
        const parentSettings = core.resolveFolderSettings(watch.settings, watch.overrides, relativeDirectory);
        if (!parentSettings.includeSubfolders) continue;
        if (discoveredFolders.length < MAX_DISCOVERED_FOLDERS) discoveredFolders.push(childRelative);
        await visit(entry, childRelative);
      } else if (entry.isFile) {
        if (entry.name.startsWith(".") || !core.isSupportedMedia(entry.name, runtime.config.extensions)) continue;
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const sequenceFrame = core.parseSequenceFrame(entry.name, runtime.config.extensions);
        const sequenceRegistryKey = sequenceFrame
          ? core.sequenceKey({ name: entry.name, path: entry.nativePath, relativePath, relativeDirectory }, runtime.config.extensions)
          : null;
        const sequenceRecord = sequenceRegistryKey ? watch.registry.sequences[sequenceRegistryKey] : null;
        const alreadyImported = importedPaths.has(core.pathKey(entry.nativePath))
          || Boolean(sequenceRecord && sequenceFrame.frame <= sequenceRecord.lastFrame);
        let metadata = null;
        if (!alreadyImported) {
          try {
            metadata = await entry.getMetadata();
          } catch (_) {
            continue;
          }
        }
        files.push({
          entry,
          name: entry.name,
          path: entry.nativePath,
          relativePath,
          relativeDirectory,
          cameraPath: `${watch.name}/${relativePath}`,
          alreadyImported,
          size: metadata ? Number(metadata.size) || 0 : 0,
          modifiedMs: metadata
            ? metadata.dateModified instanceof Date
              ? metadata.dateModified.getTime()
              : new Date(metadata.dateModified || 0).getTime()
            : 0
        });
      }
    }
  }

  await visit(folder, "");
  return { files, discoveredFolders };
}

async function mediaPathForItem(item) {
  if (!item) return "";
  if (typeof item.getMediaFilePath === "function") return item.getMediaFilePath();
  if (typeof item.getMediaPath === "function") return item.getMediaPath();
  return "";
}

async function collectProjectMediaIndex() {
  const index = new Map();
  const root = await getRootItem();
  async function visit(item) {
    if (isFolderItem(item)) {
      for (const child of await getChildren(item)) await visit(child);
      return;
    }
    try {
      const mediaPath = await mediaPathForItem(item);
      if (!mediaPath) return;
      const key = core.pathKey(mediaPath);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(item);
    } catch (_) {
      // Offline and generated items can reject media path requests.
    }
  }
  await visit(root);
  return index;
}

async function runTransaction(project, name, addActions) {
  if (!project || typeof project.lockedAccess !== "function" || typeof project.executeTransaction !== "function") {
    throw new Error("This Premiere version does not expose project transactions");
  }
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compoundAction) => {
      addActions(compoundAction);
    }, name);
  });
  if (!success) throw new Error(`Premiere rejected transaction: ${name}`);
  return true;
}

async function findChildBin(parent, name) {
  for (const child of await getChildren(parent)) {
    if (isFolderItem(child) && itemName(child) === name) return child;
  }
  return null;
}

function asFolderItem(item) {
  // Bins returned by getItems() are plain ProjectItems; only FolderItem exposes createBinAction.
  if (typeof item.createBinAction === "function") return item;
  const folderItemApi = ppro.FolderItem;
  return folderItemApi && typeof folderItemApi.cast === "function" ? folderItemApi.cast(item) : null;
}

async function createChildBin(parent, name) {
  const parentFolder = asFolderItem(parent);
  if (!parentFolder || typeof parentFolder.createBinAction !== "function") {
    throw new Error("Premiere cannot create bins through this API version");
  }
  await runTransaction(runtime.project, `Create Folder Watch bin: ${name}`, (compoundAction) => {
    compoundAction.addAction(parentFolder.createBinAction(name, false));
  });
  const created = await findChildBin(parent, name);
  if (!created) throw new Error(`Premiere did not create bin ${name}`);
  return created;
}

async function ensureBinPath(base, segments, labelIndex = null) {
  let current = base;
  for (const segment of segments) {
    let child = await findChildBin(current, segment);
    if (!child) {
      child = await createChildBin(current, segment);
      if (labelIndex !== null) await applyColorLabel(child, labelIndex);
    }
    current = child;
  }
  return current;
}

async function resolveTargetBin(watch) {
  const root = await getRootItem();
  let current = root;
  for (const segment of watch.targetBinPath || []) {
    const child = await findChildBin(current, segment);
    if (!child) throw new Error(`Destination bin is missing: ${watch.targetBinPath.join(" / ")}`);
    current = child;
  }
  return current;
}

function colorLabelValue(index) {
  if (index === null || index === undefined) return null;
  const labels = ppro.Constants && ppro.Constants.ProjectItemColorLabel;
  if (!labels) return null;
  const preferredNames = [
    "VIOLET", "IRIS", "LAVENDER", "CERULEAN", "FOREST", "ROSE", "MANGO",
    "PURPLE", "BLUE", "TEAL", "MAGENTA", "TAN", "GREEN", "BROWN", "YELLOW"
  ];
  const name = preferredNames[Number(index)];
  if (name && labels[name] !== undefined) return labels[name];
  const values = Object.keys(labels)
    .filter((key) => !/^\d+$/.test(key))
    .map((key) => labels[key])
    .filter((value, position, all) => all.indexOf(value) === position);
  return values[Number(index)] ?? null;
}

async function applyColorLabel(item, labelIndex) {
  const color = colorLabelValue(labelIndex);
  if (color === null || !item || typeof item.createSetColorLabelAction !== "function") return false;
  await runTransaction(runtime.project, "Set Folder Watch label", (compoundAction) => {
    compoundAction.addAction(item.createSetColorLabelAction(color));
  });
  return true;
}

async function refreshSequence(unit, mediaIndex) {
  const items = mediaIndex.get(core.pathKey(unit.importPath)) || [];
  const item = items[0];
  if (!item || typeof item.refreshMedia !== "function") return false;
  return Boolean(await item.refreshMedia());
}

function observationKey(watch, file) {
  return `${watch.id}\x00${core.pathKey(file.path)}`;
}

function updateStableFiles(watch, files) {
  const ready = [];
  const currentKeys = new Set();
  let pending = 0;
  for (const file of files) {
    const key = observationKey(watch, file);
    currentKeys.add(key);
    if (file.alreadyImported) {
      ready.push(file);
      continue;
    }
    const observation = core.observeFile(
      runtime.observations.get(key),
      file,
      runtime.config.stablePollsRequired
    );
    runtime.observations.set(key, observation);
    if (observation.ready) ready.push(file);
    else pending += 1;
  }
  for (const key of runtime.observations.keys()) {
    if (key.startsWith(`${watch.id}\x00`) && !currentKeys.has(key)) runtime.observations.delete(key);
  }
  return { ready, pending };
}

function registrySet(watch) {
  return new Set(watch.registry.paths.map(core.pathKey));
}

function addRegistryPaths(watch, paths) {
  const existing = registrySet(watch);
  for (const filePath of paths) existing.add(core.pathKey(filePath));
  watch.registry.paths = Array.from(existing);
}

async function syncWatch(watch, getMediaIndex, reason) {
  watch.issueCount = 0;
  watch.pendingCount = 0;
  try {
    watch.lastStatus = "pending";
    watch.lastMessage = "Scanning folder";
    renderWatchList();

    const folder = await restoreWatchEntry(watch);
    const scan = await walkFolder(folder, watch);
    watch.discoveredFolders = scan.discoveredFolders;
    const filtered = core.filterFiles(scan.files, {
      extensions: runtime.config.extensions,
      ignoredFolders: runtime.config.ignoredFolders
    });

    if (watch.baselinePending) {
      const baselineUnits = core.buildImportUnits(filtered.included, {
        extensions: runtime.config.extensions,
        settings: watch.settings,
        overrides: watch.overrides
      });
      for (const unit of baselineUnits) {
        addRegistryPaths(watch, unit.kind === "sequence" ? [unit.importPath] : unit.sourcePaths);
        if (unit.kind === "sequence") {
          watch.registry.sequences[unit.sequence.key] = {
            firstPath: unit.importPath,
            lastFrame: unit.sequence.lastFrame,
            frameCount: unit.sequence.frameCount,
            ignored: true
          };
        }
      }
      watch.baselinePending = false;
      watch.lastStatus = "ok";
      watch.lastMessage = `Watching new files after ${filtered.included.length} existing`;
      watch.lastSyncedAt = new Date().toISOString();
      addActivity(`${watch.name}: recorded ${filtered.included.length} existing files without importing`, "ok");
      return;
    }

    const stable = updateStableFiles(watch, filtered.included);
    watch.pendingCount = stable.pending;
    const planningOptions = {
      extensions: runtime.config.extensions,
      ignoredFolders: runtime.config.ignoredFolders,
      settings: watch.settings,
      overrides: watch.overrides,
      registryPaths: watch.registry.paths
    };
    const preliminaryPlan = core.planSync(stable.ready, planningOptions);
    const needsSequenceRefresh = preliminaryPlan.duplicates.some((unit) => {
      if (unit.kind !== "sequence") return false;
      const previous = watch.registry.sequences[unit.sequence.key];
      return previous && !previous.ignored && unit.sequence.lastFrame > previous.lastFrame;
    });
    const registeredPaths = registrySet(watch);
    const needsPartialSequenceRecovery = preliminaryPlan.duplicates.some((unit) => (
      unit.kind === "sequence"
      && !watch.registry.sequences[unit.sequence.key]
      && unit.sourcePaths.some((filePath) => registeredPaths.has(core.pathKey(filePath)))
    ));
    const needsProjectIndex = needsSequenceRefresh
      || (watch.settings.duplicateScan && (
        preliminaryPlan.candidates.length > 0
        || needsPartialSequenceRecovery
      ));
    const mediaIndex = needsProjectIndex ? await getMediaIndex() : new Map();
    const rawPlan = watch.settings.duplicateScan && mediaIndex.size
      ? core.planSync(stable.ready, {
        ...planningOptions,
        existingPaths: Array.from(mediaIndex.keys())
      })
      : preliminaryPlan;
    const plan = core.downgradePartialSequenceDuplicates(rawPlan, {
      registryPaths: watch.registry.paths,
      existingPaths: Array.from(mediaIndex.keys()),
      knownSequenceKeys: Object.keys(watch.registry.sequences)
    });

    for (const duplicate of plan.duplicates) {
      if (duplicate.kind !== "sequence") {
        addRegistryPaths(watch, duplicate.sourcePaths);
        continue;
      }
      const previous = watch.registry.sequences[duplicate.sequence.key];
      if (!previous) {
        watch.registry.sequences[duplicate.sequence.key] = {
          firstPath: duplicate.importPath,
          lastFrame: duplicate.sequence.lastFrame,
          frameCount: duplicate.sequence.frameCount,
          ignored: false
        };
        addRegistryPaths(watch, [duplicate.importPath]);
        continue;
      }
      if (duplicate.sequence.lastFrame <= previous.lastFrame) {
        addRegistryPaths(watch, [duplicate.importPath]);
        continue;
      }
      if (previous.ignored) {
        watch.registry.sequences[duplicate.sequence.key] = {
          ...previous,
          lastFrame: duplicate.sequence.lastFrame,
          frameCount: duplicate.sequence.frameCount
        };
        addRegistryPaths(watch, [duplicate.importPath]);
        continue;
      }
      const refreshed = await refreshSequence(duplicate, mediaIndex);
      if (refreshed) {
        watch.registry.sequences[duplicate.sequence.key] = {
          firstPath: duplicate.importPath,
          lastFrame: duplicate.sequence.lastFrame,
          frameCount: duplicate.sequence.frameCount,
          ignored: false
        };
        addRegistryPaths(watch, [duplicate.importPath]);
        addActivity(`${watch.name}: refreshed ${core.fileNameOf(duplicate.importPath)} to frame ${duplicate.sequence.lastFrame}`, "ok");
      } else if (reason !== "automatic") {
        addActivity(`${watch.name}: Premiere could not refresh the growing image sequence`, "warning", true);
      }
    }

    if (plan.candidates.length > 0) {
      const baseBin = await resolveTargetBin(watch);
      for (const unit of plan.candidates) {
        const targetBin = await ensureBinPath(baseBin, unit.destinationSegments, unit.labelIndex);
        const imported = await runtime.project.importFiles(
          [unit.importPath],
          !runtime.config.showImportDialogs,
          targetBin,
          unit.kind === "sequence"
        );
        if (!imported) throw new Error(`Premiere rejected ${core.fileNameOf(unit.importPath)}`);

        addRegistryPaths(watch, unit.kind === "sequence" ? [unit.importPath] : unit.sourcePaths);
        if (unit.kind === "sequence") {
          watch.registry.sequences[unit.sequence.key] = {
            firstPath: unit.importPath,
            lastFrame: unit.sequence.lastFrame,
            frameCount: unit.sequence.frameCount,
            ignored: false
          };
        }
        watch.importedCount += 1;

        const key = core.pathKey(unit.importPath);
        let importedItems = mediaIndex.get(key) || [];
        if (unit.labelIndex !== null) {
          const refreshedIndex = await collectProjectMediaIndex();
          importedItems = refreshedIndex.get(key) || importedItems;
          for (const item of importedItems) await applyColorLabel(item, unit.labelIndex);
          for (const [mediaKey, value] of refreshedIndex) mediaIndex.set(mediaKey, value);
        }
        mediaIndex.set(key, importedItems);
      }
      addActivity(`${watch.name}: imported ${plan.candidates.length} ${plan.candidates.length === 1 ? "item" : "items"}`, "ok");
      const recoveredFrames = plan.downgradedSequences.reduce(
        (total, unit) => total + unit.missingPaths.length,
        0
      );
      if (recoveredFrames > 0) {
        addActivity(
          `${watch.name}: kept ${recoveredFrames} new sequence-like ${recoveredFrames === 1 ? "frame" : "frames"} as individual stills because earlier frames were already imported separately`,
          "warning",
          true
        );
      }
    }

    watch.lastStatus = "ok";
    watch.lastMessage = watch.pendingCount
      ? `${watch.pendingCount} ${watch.pendingCount === 1 ? "file" : "files"} settling`
      : plan.candidates.length
        ? `Imported ${plan.candidates.length}`
        : "Up to date";
    watch.lastSyncedAt = new Date().toISOString();
  } catch (error) {
    watch.lastStatus = "error";
    watch.lastMessage = error.message;
    watch.issueCount = 1;
    addActivity(`${watch.name}: ${error.message}`, "error", true);
  }
}

async function syncAll(reason = "manual", onlyId = null) {
  if (runtime.syncing) return;
  runtime.syncing = true;
  renderToolbar();
  try {
    if (!await refreshActiveProject()) return;
    const watches = onlyId
      ? runtime.watchFolders.filter((watch) => watch.id === onlyId)
      : runtime.watchFolders;
    if (watches.length === 0) return;

    let mediaIndex = null;
    const getMediaIndex = async () => {
      if (!mediaIndex) mediaIndex = await collectProjectMediaIndex();
      return mediaIndex;
    };
    for (const watch of watches) await syncWatch(watch, getMediaIndex, reason);
    saveProjectState();
  } catch (error) {
    addActivity(`Sync failed: ${error.message}`, "error", true);
  } finally {
    runtime.syncing = false;
    if (runtime.projectRefreshPending) {
      runtime.projectRefreshPending = false;
      await refreshActiveProject();
    }
    render();
  }
}

function updateGlobalSettings() {
  runtime.config.extensions = $("extensions").value
    .split(/[\s,]+/)
    .map((value) => value.replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  runtime.config.ignoredFolders = $("ignoredFolders").value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  runtime.config.pollIntervalMs = Number($("pollInterval").value);
  runtime.config.stablePollsRequired = Number($("stablePolls").value);
  runtime.config.showImportDialogs = $("showImportDialogs").checked;
  runtime.config.notifications = $("notifications").checked;
  saveConfig();
  restartTimer();
}

function restoreDefaults() {
  const autoSync = runtime.config.autoSync;
  runtime.config = { ...clone(DEFAULT_CONFIG), autoSync };
  saveConfig();
  renderSettings();
  restartTimer();
  addActivity("Global settings restored", "neutral", true);
}

function handleWatchListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  const watch = runtime.watchFolders.find((item) => item.id === id);
  if (!watch) return;
  if (button.dataset.action === "sync") syncAll("manual", id);
  if (button.dataset.action === "selected-bin") updateWatchSelectedBin(id);
  if (button.dataset.action === "settings") openEditor(watch, false);
}

function attachEvents() {
  $("toggleWatching").addEventListener("click", () => setAutoSync(!runtime.config.autoSync));
  $("syncNow").addEventListener("click", () => syncAll("manual"));
  $("addFolder").addEventListener("click", addFolder);
  $("emptyAddFolder").addEventListener("click", addFolder);
  $("watchList").addEventListener("click", handleWatchListClick);
  $("clearActivity").addEventListener("click", () => {
    runtime.activity = [];
    renderActivity();
  });

  for (const id of [
    "extensions", "ignoredFolders", "pollInterval", "stablePolls", "showImportDialogs", "notifications"
  ]) {
    $(id).addEventListener("change", updateGlobalSettings);
  }
  $("resetSettings").addEventListener("click", restoreDefaults);

  $("overridePath").addEventListener("change", () => {
    storeEditorControls();
    loadEditorControls($("overridePath").value);
  });
  $("closeEditor").addEventListener("click", closeEditor);
  $("cancelEditor").addEventListener("click", closeEditor);
  $("saveEditor").addEventListener("click", saveEditor);
  $("removeFolder").addEventListener("click", removeEditorFolder);
  $("relinkFolder").addEventListener("click", relinkEditorFolder);
  $("createChildFolder").addEventListener("click", createEditorChildFolder);
  $("useSelectedBin").addEventListener("click", setEditorSelectedBin);
  $("editorBackdrop").addEventListener("click", (event) => {
    if (event.target === $("editorBackdrop")) closeEditor();
  });
}

function registerProjectEvents() {
  const manager = ppro.EventManager;
  const events = ppro.Constants && ppro.Constants.ProjectEvent;
  if (!manager || typeof manager.addGlobalEventListener !== "function" || !events) return;
  runtime.projectEventHandler = () => {
    if (runtime.syncing) {
      runtime.projectRefreshPending = true;
      return;
    }
    refreshActiveProject().then((available) => {
      if (available && runtime.config.autoSync) syncAll("automatic");
    });
  };
  for (const eventName of [events.OPENED, events.CLOSED, events.ACTIVATED]) {
    manager.addGlobalEventListener(eventName, runtime.projectEventHandler);
  }
}

function unregisterProjectEvents() {
  const manager = ppro.EventManager;
  const events = ppro.Constants && ppro.Constants.ProjectEvent;
  if (!runtime.projectEventHandler || !manager || typeof manager.removeGlobalEventListener !== "function" || !events) return;
  for (const eventName of [events.OPENED, events.CLOSED, events.ACTIVATED]) {
    manager.removeGlobalEventListener(eventName, runtime.projectEventHandler);
  }
  runtime.projectEventHandler = null;
}

function initialize() {
  if (runtime.initialized) return;
  runtime.initialized = true;
  attachEvents();
  registerProjectEvents();
  renderSettings();
  render();
  refreshActiveProject().then(() => {
    if (runtime.config.autoSync) {
      restartTimer();
      syncAll("automatic");
    }
  });
}

entrypoints.setup({
  panels: {
    folderWatchPanel: {
      show() {
        runtime.visible = true;
        initialize();
        refreshActiveProject();
      },
      hide() {
        runtime.visible = false;
      },
      destroy() {
        runtime.visible = false;
        if (runtime.timer) clearInterval(runtime.timer);
        runtime.timer = null;
        unregisterProjectEvents();
      }
    }
  }
});
