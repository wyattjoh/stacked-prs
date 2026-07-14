// Browser client for `stacked-prs serve`. Authored as a standalone source file
// and embedded into the served document at build time (see serve.ts). It renders
// the stack views entirely from the /api/status payload.

const app = document.querySelector("#app");
const PALETTE = [
  "#539bf5",
  "#a371f7",
  "#d2954a",
  "#57ab5a",
  "#e0809d",
  "#6bbfb0",
];
const GRAY = "#6e7681";
const CARD = "#0d1117";
// Horizontal padding of the `.app-content` card; tinted branch rows full-bleed
// past it via negative margins. Keep in sync with serve.css `.app-content`.
const CARD_PAD_X = 26;
const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS = '"Space Grotesk", ui-sans-serif, system-ui, sans-serif';

const ALL_ID = "__all__";

// View state lives in per-tab sessionStorage: it survives reload, never bleeds
// across separate `serve` windows, and is cleared when the tab closes (so a
// later `serve` session over a different folder set never inherits a stale
// selection). The URL carries no view state.
const SELECTED_KEY = "stacked-prs:selected-stack";

function readSelected() {
  try {
    return sessionStorage.getItem(SELECTED_KEY) || ALL_ID;
  } catch {
    return ALL_ID;
  }
}

function setSelected(id) {
  try {
    sessionStorage.setItem(SELECTED_KEY, id);
  } catch {
    // sessionStorage unavailable (private mode); keep the selection ephemeral.
  }
}

const REPOS_KEY = "stacked-prs:selected-repos";

function persistRepos(set) {
  try {
    sessionStorage.setItem(REPOS_KEY, JSON.stringify([...set]));
  } catch {
    // sessionStorage unavailable (private mode); keep the selection ephemeral.
  }
}

function setSelectedRepos(set) {
  persistRepos(set);
  render();
}

function selectStack(id) {
  state.selectedId = id;
  state.open = false;
  state.repoOpen = false;
  setSelected(id);
  render();
}

const ARCHIVED_KEY = "stacked-prs:show-archived";

function setShowArchived(value) {
  state.showArchived = value;
  try {
    localStorage.setItem(ARCHIVED_KEY, value ? "1" : "0");
  } catch {
    // localStorage unavailable (private mode); keep the toggle ephemeral.
  }
  render();
}

// Most recent commit timestamp (ISO 8601) across a stack's repos, or null when
// none resolve. ISO strings in the same UTC format compare lexicographically in
// time order, so plain `>` finds the max.
function stackRecency(repos) {
  let max = null;
  for (const r of repos) {
    if (r.latestCommitAt && (!max || r.latestCommitAt > max)) {
      max = r.latestCommitAt;
    }
  }
  return max;
}

// Order stacks most-recent-commit first; stacks with no commit date sort last,
// ties broken alphabetically by name.
function compareRecency(a, b) {
  const at = a.latestCommitAt;
  const bt = b.latestCommitAt;
  if (at && bt) {
    return at === bt ? a.name.localeCompare(b.name) : bt.localeCompare(at);
  }
  if (at) return -1;
  if (bt) return 1;
  return a.name.localeCompare(b.name);
}

// Apply the archived toggle and the repository filter, then order by recency.
// Each surviving stack is cloned with its repos narrowed to the selected paths
// and its summary and latestCommitAt recomputed over that narrowed set; stacks
// left with no selected repo drop out. Colors are unaffected because
// `stackColors` is keyed by stack id and assigned once in buildModel.
function visibleStacks() {
  const archivedFiltered = state.showArchived
    ? stacks
    : stacks.filter((s) => !s.archived);
  return archivedFiltered
    .map((s) => {
      const repos = s.repos.filter((r) => state.selectedRepos.has(r.path));
      return {
        ...s,
        repos,
        summary: repoSummary(repos),
        latestCommitAt: stackRecency(repos),
      };
    })
    .filter((s) => s.repos.length > 0)
    .sort(compareRecency);
}

const state = {
  selectedId: readSelected(),
  open: false,
  repoOpen: false,
  // Selected repository paths; reconciled against the served repos on load.
  selectedRepos: new Set(),
  showArchived: (() => {
    try {
      return localStorage.getItem(ARCHIVED_KEY) === "1";
    } catch {
      return false;
    }
  })(),
};
let stacks = [];
let stackColors = new Map();
let allRepos = [];
// Raw /api/status repositories keyed by unique path, kept so a live
// `repo-updated` event can upsert a single repo and rebuild the model.
let reposByPath = new Map();
let watching = false;
let toastHost = null;

// Per-path load state for the progress screen: "queued" | "loading" | "done" |
// "error". Reset each time loadStatus() runs. Error messages are kept alongside
// so error rows can show why a repo failed, and loadInfo maps a path back to its
// {name, path} for the row label.
let loadOrder = [];
const loadState = new Map();
const loadError = new Map();
const loadInfo = new Map();

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") node.setAttribute("style", value);
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child) node.append(child);
  }
  return node;
}

function hexToRgba(hex, a) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function stackColor(id) {
  return stackColors.get(id) || "#8b949e";
}

function splitName(name) {
  const i = name.indexOf("/");
  if (i < 0) return { prefix: "", mainName: name };
  return { prefix: name.slice(0, i + 1), mainName: name.slice(i + 1) };
}

// "N repos · M branches" summary for a stack's repo list. Recomputed whenever
// the repo filter narrows a stack so the header summary stays accurate.
function repoSummary(repos) {
  const n = repos.reduce((sum, r) => sum + r.branches.length, 0);
  const repoLabel = `${repos.length} repo${repos.length === 1 ? "" : "s"}`;
  const branchLabel = `${n} branch${n === 1 ? "" : "es"}`;
  return `${repoLabel} · ${branchLabel}`;
}

// Format an ISO timestamp as a muted "N units ago" label, computed against the
// browser's current time at render so it stays roughly current and refreshes on
// every live-watch re-render. Returns "" for null/invalid input.
function formatRelativeTime(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return "just now";
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [name, size] of units) {
    if (secs >= size) {
      const n = Math.floor(secs / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

// Group every stack by name so a stack shared across repos collapses into one
// entry, then assign each a stable color and summary.
function buildModel(repositories) {
  const map = new Map();
  for (const repo of repositories) {
    const repoStacks = (repo.status && repo.status.stacks) || [];
    for (const stack of repoStacks) {
      let entry = map.get(stack.stackName);
      if (!entry) {
        entry = { id: stack.stackName, name: stack.stackName, repos: [] };
        map.set(stack.stackName, entry);
      }
      entry.repos.push({
        name: repo.name,
        path: repo.path,
        github: repo.github ? `${repo.github.owner}/${repo.github.repo}` : null,
        baseBranch: stack.baseBranch,
        branches: stack.branches || [],
        graph: stack.graph || { rows: [], maxLane: 0 },
        archived: stack.archived === true,
        latestCommitAt: stack.latestCommitAt || null,
      });
    }
  }
  const list = Array.from(map.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const s of list) {
    // Order each stack's repos alphabetically by name (tie-broken on the unique
    // path) so single-stack lanes read in a stable order.
    s.repos.sort((a, b) =>
      a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
    );
    // A group is archived only when every contributing repo's stack is archived.
    s.archived = s.repos.length > 0 && s.repos.every((r) => r.archived);
  }
  stackColors = new Map(
    list.map((s, i) => [s.id, PALETTE[i % PALETTE.length]]),
  );
  for (const s of list) {
    s.summary = repoSummary(s.repos);
  }
  return list;
}

function tagSpan(text, style) {
  return el("span", { style, text });
}

const SVG_NS = "http://www.w3.org/2000/svg";

// GitHub Octicon paths (16x16 viewBox). Rendered with currentColor so each
// icon inherits the surrounding PR badge color.
const PR_ICONS = {
  // git-pull-request
  open:
    "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  // git-pull-request-draft
  draft:
    "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm0 3.5a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm0 8a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0-9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 3a.75.75 0 0 1 .75.75v2.378a2.251 2.251 0 1 1-1.5 0V6.75a.75.75 0 0 1 .75-.75Z",
  // git-merge
  merged:
    "M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z",
  // git-pull-request-closed
  closed:
    "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z",
  // git-pull-request (used in gray for the no-PR slot)
  none:
    "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
};

const UI_ICONS = {
  // copy
  copy:
    "M0 6.75C0 5.784.784 5 1.75 5H4.5v1.5H1.75a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25V11.5H11v2.75A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Zm5-5C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z",
  // filter
  filter:
    "M0 3.75A.75.75 0 0 1 .75 3h14.5a.75.75 0 0 1 .53 1.28L10 10.06v4.19a.75.75 0 0 1-1.14.64l-3-1.83a.75.75 0 0 1-.36-.64v-2.36L.22 4.28A.75.75 0 0 1 0 3.75ZM2.56 4.5l4.22 4.62a.75.75 0 0 1 .2.5v2.38l1.52.93V9.62a.75.75 0 0 1 .22-.53l4.59-4.59Z",
};

function icon(path, size = 12) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.style.flex = "none";
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", path);
  svg.append(p);
  return svg;
}

function nameActionButton(className, title, iconPath, onClick) {
  const btn = el("button", {
    class: `name-action-button ${className}`,
    type: "button",
    title,
    "aria-label": title,
  }, [icon(iconPath, 12)]);
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
    btn.blur();
  });
  return btn;
}

async function copyName(kind, value) {
  const label = kind === "stack" ? "stack name" : "branch name";
  try {
    await navigator.clipboard.writeText(value);
    toast(`Copied ${label}`);
  } catch {
    toast(`Failed to copy ${label}`);
  }
}

function copyNameButton(kind, value) {
  const title = kind === "stack" ? "Copy stack name" : "Copy branch name";
  return nameActionButton(
    "copy-name-button",
    title,
    UI_ICONS.copy,
    () => copyName(kind, value),
  );
}

function filterStackButton(stackId) {
  return nameActionButton(
    "filter-stack-button",
    "Show only this stack",
    UI_ICONS.filter,
    () => selectStack(stackId),
  );
}

function prTag(pr) {
  const base =
    `font:500 11px/1.4 ${MONO};padding:2px 8px;border-radius:5px;white-space:nowrap;display:inline-flex;align-items:center;gap:5px;`;
  if (!pr) {
    return el(
      "span",
      { style: `${base}color:#6e7681;border:1px solid #30363d;` },
      [icon(PR_ICONS.none), el("span", { text: "no PR" })],
    );
  }
  const prState = (pr.state || "").toUpperCase();
  let kind = "open";
  let word = "open";
  if (prState === "MERGED") {
    kind = "merged";
    word = "merged";
  } else if (prState === "CLOSED") {
    kind = "closed";
    word = "closed";
  } else if (pr.isDraft) {
    kind = "draft";
    word = "draft";
  }
  const palette = {
    open:
      "color:#3fb950;background:rgba(63,185,80,.08);border:1px solid rgba(63,185,80,.4);",
    draft:
      "color:#d29922;background:rgba(210,153,34,.1);border:1px solid rgba(210,153,34,.4);",
    merged:
      "color:#d2a8ff;background:rgba(163,113,247,.14);border:1px solid rgba(163,113,247,.35);",
    closed:
      "color:#ff7b72;background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.3);",
  };
  const style = base + (palette[kind] || "");
  const children = [
    icon(PR_ICONS[kind]),
    el("span", { text: `#${pr.number} ${word}` }),
  ];
  if (pr.url) {
    return el("a", {
      class: "dc-pr",
      href: pr.url,
      target: "_blank",
      rel: "noopener",
      style: `${style}text-decoration:none;`,
    }, children);
  }
  return el("span", { style }, children);
}

function statusBadge(b) {
  const pill = "font:500 11px/1.4 " + MONO +
    ";padding:2px 8px;border-radius:5px;white-space:nowrap;";
  if (b.syncStatus === "diverged") {
    return tagSpan(
      "diverged",
      `${pill}color:#ff7b72;background:rgba(248,81,73,.12);border:1px solid rgba(248,81,73,.28);`,
    );
  }
  if (b.syncStatus === "behind-parent") {
    return tagSpan(
      "behind",
      `${pill}color:#d29922;background:rgba(210,153,34,.1);border:1px solid rgba(210,153,34,.4);`,
    );
  }
  if (b.syncStatus === "landed") {
    return tagSpan(
      "landed",
      `${pill}color:#d2a8ff;background:rgba(163,113,247,.14);border:1px solid rgba(163,113,247,.35);`,
    );
  }
  return null;
}

function headerCounts(branchList) {
  let diverged = 0;
  let openPRs = 0;
  for (const b of branchList) {
    if (b.syncStatus === "diverged") diverged++;
    if (b.pr && (b.pr.state || "").toUpperCase() === "OPEN") openPRs++;
  }
  const tags = [];
  if (diverged) {
    tags.push(tagSpan(
      `${diverged} diverged`,
      `font:500 11px ${MONO};color:#ff7b72;background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.28);padding:2px 8px;border-radius:20px;`,
    ));
  }
  if (openPRs) {
    tags.push(tagSpan(
      `${openPRs} open PR${openPRs === 1 ? "" : "s"}`,
      `font:500 11px ${MONO};color:#56d364;background:rgba(63,185,80,.1);border:1px solid rgba(63,185,80,.28);padding:2px 8px;border-radius:20px;`,
    ));
  }
  return tags;
}

function scopeBranches(scope) {
  const out = [];
  for (const s of scope) {
    for (const r of s.repos) {
      for (const b of r.branches) out.push(b);
    }
  }
  return out;
}

// Sync-status badge that sits inline, immediately to the right of the branch
// name. Returns null when the branch is up to date so no slot is reserved.
function inlineStatus(b) {
  const badge = statusBadge(b);
  if (!badge) return null;
  return el("span", {
    style: "margin-left:8px;display:inline-flex;flex:none;",
  }, [badge]);
}

// PR badge pinned to the right edge of the row. `margin-left:auto` pushes it
// past the inline branch name + status so PR badges stay right-aligned.
function prRail(pr) {
  return el("span", {
    style:
      "margin-left:auto;display:inline-flex;align-items:center;flex:none;padding-left:12px;",
  }, [prTag(pr)]);
}

function checkedOutBadge(c) {
  return el("span", {
    style:
      `margin-left:8px;font:600 10px ${MONO};color:${CARD};background:${c};padding:2px 7px;border-radius:5px;`,
    text: "checked out",
  });
}

function branchLabel(prefix, mainName, mainColor, size) {
  return el("span", { style: `font:600 ${size}px ${MONO};` }, [
    el("span", { style: "color:#6e7681;", text: prefix }),
    el("span", { style: `color:${mainColor};`, text: mainName }),
  ]);
}

// Lane-based branch graph rendering. Each stack is drawn from the server-computed
// `graph` (lanes + fork targets) so a branch with two or more children fans out
// into parallel lanes, matching the fork topology the CLI ladder renders. One
// color per stack keeps the view consistent with the switcher dots.

// Vertical lane segment centered on column x. `half` is "top" (connect up),
// "bottom" (connect down), or "full". The 2px border is offset by 1px so the
// line centers on x, aligning with node dots and curved corners. Dashed mirrors
// the CLI's diverged styling. Branch rows can grow taller than the label row
// when descriptions render, so branch rows pass `center` to keep rail halves
// anchored to the fixed node center instead of the full row midpoint.
function vseg(x, color, half, dashed, center = null) {
  const pos = half === "top"
    ? center == null ? "top:0;height:50%;" : `top:0;height:${center}px;`
    : half === "bottom"
    ? center == null ? "top:50%;bottom:0;" : `top:${center}px;bottom:0;`
    : "top:0;bottom:0;";
  return el("span", {
    style: `position:absolute;left:${x - 1}px;${pos}width:0;border-left:2px ${
      dashed ? "dashed" : "solid"
    } ${color};`,
  });
}

// Curved corner connector: a horizontal segment entering from xFrom that curves
// down into a vertical centered on xTo, mirroring the rounded main-branch elbow.
// `vstyle` positions the corner vertically within its container; the horizontal
// sits at the container's top edge and the vertical drops to its bottom edge.
function curveCorner(xFrom, xTo, vstyle, color, dashed, radius) {
  const ds = dashed ? "dashed" : "solid";
  // The right border (the vertical) is drawn 2px inside the right edge; offset
  // the edge by 1px so the line centers on xTo like nodes and vseg do.
  const width = xTo - xFrom + 1;
  return el("span", {
    style: `position:absolute;left:${xFrom}px;${vstyle}width:${width}px;` +
      `border-top:2px ${ds} ${color};border-right:2px ${ds} ${color};` +
      `border-top-right-radius:${radius}px;`,
  });
}

function nodeEl(x, color, current, isBase, nodeCenter) {
  const top = !isBase && nodeCenter ? `${nodeCenter}px` : "50%";
  const base =
    `position:absolute;left:${x}px;top:${top};width:12px;height:12px;border-radius:50%;border:2px solid ${CARD};z-index:2;`;
  if (isBase) {
    return el("span", {
      style:
        `${base}transform:translate(-50%,-50%);background:${CARD};border-color:${GRAY};`,
    });
  }
  // Branch node: `.branch-node` (serve.css) owns the centering transform plus
  // the ring/scale hover highlight, reading the `--node-ring` color inherited
  // from the row. The current branch keeps a persistent ring via the modifier.
  const cls = current ? "branch-node branch-node--current" : "branch-node";
  return el("span", { class: cls, style: `${base}background:${color};` });
}

// Width of the lane gutter that precedes a branch label. The label starts a
// fixed 21px gap past the rightmost lane's node column (pad + maxLane*laneW), so
// branch labels and the `main`/stack-name headers can meet on a single column.
function laneAreaWidth(maxLane, pad, laneW) {
  return pad + (maxLane || 0) * laneW + 21;
}

// Widest lane index across a list of graphs, so every branch label can share one
// gutter width and start at the same x. Keeps the left edge of labels flush down
// the whole page instead of stepping right per forked stack.
function maxLaneAcross(graphs) {
  let max = 0;
  for (const g of graphs) {
    const m = (g && g.maxLane) || 0;
    if (m > max) max = m;
  }
  return max;
}

// Render every row of a stack's branch graph. `ctx` carries the lane geometry
// (pad/laneW/row height/font/color) and whether the first row should connect
// upward to a base node directly above it (single-stack view) or via an external
// elbow (all-stacks view). Each row carries explicit `rails` (per-lane up/down
// half segments) computed server-side, so connectivity is never inferred from
// adjacency and separate same-lane segments stay distinct.
function renderGraphRows(graph, ctx) {
  const rows = (graph && graph.rows) || [];
  // `laneOffset` right-aligns this stack's lanes within the shared gutter, so its
  // rightmost node lands in the same column just left of the labels regardless of
  // how shallow it is. Shallow stacks therefore start further right (closer to
  // their label) instead of leaving a wide gap when deeper stacks are present.
  const laneX = (lane) => ctx.pad + (lane + (ctx.laneOffset || 0)) * ctx.laneW;
  return rows.map((row, i) => {
    const nodeCenter = Math.round(ctx.row / 2);
    const status = row.branchStatus;
    const diverged = !!(status && status.syncStatus === "diverged");
    const co = !!(status && status.isCurrent);
    const lane = el("div", {
      style:
        `width:${ctx.laneAreaW}px;flex:none;position:relative;align-self:stretch;z-index:1;`,
    });
    // A branching child's lane owns its parent-row vertical via the curved
    // corner below, so skip the plain down-half rail there to avoid doubling.
    const forkLanes = new Set((row.forkTargets || []).map((t) => t.lane));
    // Vertical trunk rails: draw the up/down halves the server marked active.
    for (const rail of row.rails || []) {
      const x = laneX(rail.lane);
      if (rail.up) {
        lane.append(vseg(x, ctx.color, "top", rail.upDashed, nodeCenter));
      }
      if (rail.down && !forkLanes.has(rail.lane)) {
        lane.append(
          vseg(x, ctx.color, "bottom", rail.downDashed, nodeCenter),
        );
      }
    }
    // Single-stack view: link the first branch up to the base node above it.
    if (ctx.firstConnectsUp && i === 0) {
      lane.append(
        vseg(laneX(row.lane), ctx.color, "top", diverged, nodeCenter),
      );
    }
    // Fork: curve out and down to each branching child's lane, matching the
    // rounded main-branch elbow rather than a sharp right-angle turn.
    if (row.isFork) {
      const radius = Math.min(12, ctx.laneW, nodeCenter);
      for (const target of row.forkTargets) {
        lane.append(
          curveCorner(
            laneX(row.lane),
            laneX(target.lane),
            `top:${nodeCenter}px;bottom:0;`,
            ctx.color,
            target.dashed,
            radius,
          ),
        );
      }
    }
    lane.append(nodeEl(laneX(row.lane), ctx.color, co, false, nodeCenter));
    const nm = splitName(row.branch);
    const mainChildren = [
      branchLabel(nm.prefix, nm.mainName, "#e6edf3", ctx.font),
    ];
    mainChildren.push(inlineStatus(status));
    if (co) mainChildren.push(checkedOutBadge(ctx.color));
    mainChildren.push(el("span", {
      class: "name-action-group branch-name-action-group",
    }, [
      copyNameButton("branch", row.branch),
    ]));
    mainChildren.push(prRail(status ? status.pr : null));
    const mainLine = el("div", {
      style: `display:flex;align-items:center;min-height:${ctx.row}px;`,
    }, mainChildren);

    const contentChildren = [mainLine];
    if (status && status.descriptionHtml) {
      const desc = el("div", {
        class: "branch-desc",
      });
      desc.innerHTML = status.descriptionHtml;
      contentChildren.push(desc);
    }
    const content = el("div", {
      style:
        "flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;",
    }, contentChildren);

    // Full-bleed each tinted row to the card's inner edges so a stack reads as
    // an edge-to-edge color band. Negative margins push the background into the
    // card's horizontal padding; equal padding keeps the lane/label content
    // aligned with the untinted main and stack-name rows.
    let rowStyle =
      `display:flex;align-items:stretch;min-height:${ctx.row}px;position:relative;` +
      `margin-left:-${CARD_PAD_X}px;margin-right:-${CARD_PAD_X}px;` +
      `padding-left:${CARD_PAD_X}px;padding-right:${CARD_PAD_X}px;`;
    // Zebra-stripe each branch row in the stack's own color at alternating
    // opacity so a stack reads as one tinted block and neighboring branch rows
    // stay visually separable. The checked-out row gets a stronger fill so it
    // still stands out above the zebra tint. Base/main rows are rendered
    // elsewhere (singleBaseRow / mainRow) and stay untinted. The tint, its
    // brighter hover variant, and the node ring color are passed as CSS
    // variables so serve.css can brighten the row and highlight its node dot on
    // hover without re-deriving the per-stack color.
    const tintAlpha = co ? 0.13 : (i % 2 === 0 ? 0.045 : 0.028);
    const hoverAlpha = co ? 0.2 : 0.1;
    rowStyle += `--row-tint:${hexToRgba(ctx.color, tintAlpha)};` +
      `--row-tint-hover:${hexToRgba(ctx.color, hoverAlpha)};` +
      `--node-ring:${hexToRgba(ctx.color, 0.5)};`;
    return el("div", { class: "branch-row", style: rowStyle }, [lane, content]);
  });
}

// SINGLE-STACK VIEW: a per-repo lane graph with a base node on top.
function singleBaseRow(baseBranch, ctx, hasRows) {
  const lane = el("div", {
    style:
      `width:${ctx.laneAreaW}px;flex:none;position:relative;align-self:stretch;z-index:1;`,
  });
  // Anchor the base node on lane 0's right-aligned column so the first branch's
  // up-rail lands on it.
  const x0 = ctx.pad + (ctx.laneOffset || 0) * ctx.laneW;
  if (hasRows) lane.append(vseg(x0, GRAY, "bottom", false));
  lane.append(nodeEl(x0, GRAY, false, true));
  return el("div", {
    style: `display:flex;align-items:center;min-height:${ctx.row}px;`,
  }, [lane, branchLabel("", baseBranch, "#909dab", ctx.font)]);
}

function renderSingle(stack) {
  const frag = document.createDocumentFragment();
  const color = stackColor(stack.id);
  const pad = 18;
  const laneW = 22;
  // One gutter width for every repo's branch rows so labels align down the page.
  const globalMaxLane = maxLaneAcross(stack.repos.map((r) => r.graph));
  const laneAreaW = laneAreaWidth(globalMaxLane, pad, laneW);
  for (const repo of stack.repos) {
    const graph = repo.graph || { rows: [], maxLane: 0 };
    const ctx = {
      pad,
      laneW,
      color,
      row: 40,
      font: 13,
      laneAreaW,
      laneOffset: globalMaxLane - (graph.maxLane || 0),
      firstConnectsUp: true,
    };
    const wrap = el("div", { style: "margin-bottom:14px;" });
    wrap.append(
      el("div", {
        style: "display:flex;align-items:baseline;gap:8px;margin:0 0 2px 2px;",
      }, [
        el("span", {
          style: `font:700 13px ${MONO};color:#e6edf3;`,
          text: repo.name,
        }),
        el("span", {
          style: `font:400 11px ${MONO};color:#586069;`,
          text: `${repo.github || repo.name} · ${repo.branches.length} stacked`,
        }),
        ...(formatRelativeTime(repo.latestCommitAt)
          ? [el("span", {
            style: `font:400 11px ${MONO};color:#586069;`,
            text: `· ${formatRelativeTime(repo.latestCommitAt)}`,
          })]
          : []),
      ]),
    );
    const laneEl = el("div", { style: "position:relative;" });
    laneEl.append(
      singleBaseRow(repo.baseBranch, ctx, (graph.rows || []).length > 0),
    );
    for (const r of renderGraphRows(graph, ctx)) laneEl.append(r);
    wrap.append(laneEl);
    frag.append(wrap);
  }
  return frag;
}

// ALL-STACKS VIEW: main at the root of each repo, every stack descending off it
// as a lane graph so forks branch the same way the CLI renders them.
function renderAll(stacksList) {
  const frag = document.createDocumentFragment();
  const NODE_C = 18;
  const LABEL_H = 26;
  const pad = 44;
  const laneW = 22;
  const repoOrder = [];
  const repoStacks = new Map();
  const allGraphs = [];
  for (const s of stacksList) {
    for (const repo of s.repos) {
      if (!repoStacks.has(repo.name)) {
        repoStacks.set(repo.name, []);
        repoOrder.push(repo.name);
      }
      repoStacks.get(repo.name).push({ stack: s, repo });
      allGraphs.push(repo.graph);
    }
  }
  // Render the repo sections alphabetically rather than in stack-iteration order.
  repoOrder.sort((a, b) => a.localeCompare(b));
  // One gutter width for every branch row across every stack and repo on the
  // page, so branch labels share a single left edge regardless of fork depth.
  const laneAreaMaxLane = maxLaneAcross(allGraphs);
  const laneAreaW = laneAreaWidth(laneAreaMaxLane, pad, laneW);
  for (const repoName of repoOrder) {
    const groups = repoStacks.get(repoName);
    const repoWrap = el("div", { style: "margin-bottom:26px;" });
    repoWrap.append(
      el("div", {
        style: "display:flex;align-items:baseline;gap:8px;margin:0 0 6px 2px;",
      }, [
        el("span", {
          style: `font:700 13px ${MONO};color:#e6edf3;`,
          text: repoName,
        }),
      ]),
    );
    const tree = el("div", { style: "position:relative;" });
    const mainRow = el("div", {
      style:
        "display:flex;align-items:center;min-height:36px;position:relative;",
    });
    const mainCol = el("div", {
      style:
        `width:${laneAreaW}px;flex:none;position:relative;align-self:stretch;`,
    });
    mainCol.append(el("span", {
      style:
        `position:absolute;left:12px;top:50%;transform:translateY(-50%);width:12px;height:12px;border-radius:50%;background:${CARD};border:2px solid ${GRAY};z-index:2;`,
    }));
    mainCol.append(el("span", {
      style:
        `position:absolute;left:17px;top:${NODE_C}px;bottom:0;width:2px;background:${GRAY};`,
    }));
    mainRow.append(mainCol);
    mainRow.append(
      el("span", {
        style: `font:600 13px ${MONO};color:#909dab;`,
        text: groups[0].repo.baseBranch || "main",
      }),
    );
    tree.append(mainRow);
    groups.forEach((g, gi) => {
      const c = stackColor(g.stack.id);
      const isLast = gi === groups.length - 1;
      const n = g.repo.branches.length;
      const stackWrap = el("div", { style: "position:relative;" });
      stackWrap.append(el("div", {
        style:
          `position:absolute;left:17px;top:0;width:2px;background:${GRAY};${
            isLast ? `height:${LABEL_H}px;` : "bottom:0;"
          }`,
      }));
      const stackLabel = g.stack.archived
        ? `${g.stack.name} (archived)`
        : g.stack.name;
      const latestCommitLabel = formatRelativeTime(g.repo.latestCommitAt);
      stackWrap.append(el("div", {
        class: "stack-header-row",
        style:
          `padding-left:${laneAreaW}px;height:26px;display:flex;align-items:center;gap:8px;padding-right:6px;`,
      }, [
        el("span", {
          style: `font:600 11px ${MONO};color:${c};${
            g.stack.archived ? "opacity:0.6;" : ""
          }`,
          text: stackLabel,
        }),
        ...(latestCommitLabel
          ? [el("span", {
            style: `font:500 10px ${MONO};color:#586069;`,
            text: latestCommitLabel,
          })]
          : []),
        el("span", {
          class: "name-action-group stack-name-action-group",
        }, [
          copyNameButton("stack", g.stack.name),
          filterStackButton(g.stack.id),
        ]),
        el("span", { style: "flex:1;height:1px;background:#21262d;" }),
        el("span", {
          style: `font:500 10px ${MONO};color:#586069;`,
          text: `${n} ${n === 1 ? "branch" : "branches"}`,
        }),
      ]));
      const inner = el("div", { style: "position:relative;" });
      const graph = g.repo.graph || { rows: [], maxLane: 0 };
      const firstRow = graph.rows && graph.rows[0];
      // The elbow connects the stack's first (lane 0) branch to the trunk above
      // it; dash it when that branch has diverged, mirroring the inter-branch
      // links.
      const firstDiverged = !!(firstRow && firstRow.branchStatus &&
        firstRow.branchStatus.syncStatus === "diverged");
      // Right-align this stack's lanes within the shared gutter; shallow stacks
      // shift right so their node sits just left of the labels like deep stacks.
      const laneOffset = laneAreaMaxLane - (graph.maxLane || 0);
      const lane0X = pad + laneOffset * laneW;
      // Curve from the gray main trunk (centered on x=18) down into lane 0 of
      // the stack, landing exactly on the first node's column so dots and rails
      // line up. Same rounded shape as the in-stack fork corners.
      inner.append(
        curveCorner(
          18,
          lane0X,
          `top:0;height:${NODE_C}px;`,
          c,
          firstDiverged,
          13,
        ),
      );
      const ctx = {
        pad,
        laneW,
        color: c,
        row: 36,
        font: 12,
        laneAreaW,
        laneOffset,
        firstConnectsUp: false,
      };
      for (const r of renderGraphRows(graph, ctx)) inner.append(r);
      stackWrap.append(inner);
      tree.append(stackWrap);
    });
    repoWrap.append(tree);
    frag.append(repoWrap);
  }
  return frag;
}

function menuItem(name, summary, dot, active, isAll, onClick) {
  const itemStyle =
    "display:flex;align-items:center;gap:10px;width:100%;background:transparent;border:none;border-radius:6px;padding:8px 10px;cursor:pointer;text-align:left;" +
    (active ? "background:#1c2330;" : "");
  const dotRadius = isAll ? "2px" : "50%";
  const btn = el("button", {
    class: "dc-menu-item",
    type: "button",
    style: itemStyle,
  }, [
    el("span", {
      style:
        `width:9px;height:9px;border-radius:${dotRadius};flex:none;background:${dot};`,
    }),
    el("span", {
      style: "display:flex;flex-direction:column;gap:2px;text-align:left;",
    }, [
      el("span", { style: `font:600 13px ${MONO};color:#e6edf3;`, text: name }),
      el("span", {
        style: `font:400 11px ${MONO};color:#6e7681;`,
        text: summary,
      }),
    ]),
    el("span", {
      style: `margin-left:auto;font:600 12px ${MONO};color:#56d364;`,
      text: active ? "✓" : "",
    }),
  ]);
  btn.addEventListener("click", onClick);
  return btn;
}

function emptyState(
  title = "No stacks found",
  subtitle = "No repositories with stacked PR metadata were found.",
) {
  const wrap = el("div", { style: "padding:74px 20px;text-align:center;" });
  wrap.append(el("div", {
    style:
      "width:48px;height:48px;border-radius:50%;border:2px dashed #30363d;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;",
  }, [
    el("span", {
      style: "width:10px;height:10px;border-radius:50%;background:#30363d;",
    }),
  ]));
  wrap.append(
    el("div", {
      style: `font:600 16px ${SANS};color:#c9d1d9;margin-bottom:6px;`,
      text: title,
    }),
  );
  wrap.append(el("div", {
    style: `font:400 13px ${MONO};color:#6e7681;`,
    text: subtitle,
  }));
  return wrap;
}

function renderHeaderSwitcher(isEmpty, isAll, sel, id, visible) {
  const switcher = el("div", { style: "position:relative;" });
  const buttonLabel = isEmpty
    ? "No stacks"
    : isAll
    ? "All stacks"
    : (sel.archived ? `${sel.name} (archived)` : sel.name);
  const buttonColor = isEmpty ? "#8b949e" : "#e6edf3";
  const btn = el("button", {
    class: "dc-switcher",
    type: "button",
    style:
      "display:inline-flex;align-items:center;gap:10px;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:8px 13px;cursor:pointer;",
  }, [
    el("span", {
      style: `font:700 15px ${SANS};color:${buttonColor};`,
      text: buttonLabel,
    }),
    el("span", {
      style:
        `font:400 11px ${MONO};color:#6e7681;transition:transform .15s;transform:${
          state.open ? "rotate(180deg)" : "rotate(0deg)"
        };`,
      text: "▾",
    }),
  ]);
  btn.addEventListener("click", () => {
    state.open = !state.open;
    state.repoOpen = false;
    render();
  });
  switcher.append(btn);

  if (state.open && !isEmpty) {
    const overlay = el("div", { style: "position:fixed;inset:0;z-index:10;" });
    overlay.addEventListener("click", () => {
      state.open = false;
      render();
    });
    switcher.append(overlay);
    const menu = el("div", {
      style:
        "position:absolute;top:calc(100% + 6px);left:0;z-index:20;background:#161b22;border:1px solid #30363d;border-radius:10px;padding:6px;min-width:340px;box-shadow:0 12px 32px rgba(0,0,0,.5);",
    });
    menu.append(el("div", {
      style:
        `font:600 10px ${MONO};color:#6e7681;text-transform:uppercase;letter-spacing:.06em;padding:6px 10px 8px;`,
      text: "Stacks across repositories",
    }));
    menu.append(
      menuItem(
        "All stacks",
        "every stack, grouped by repo",
        "linear-gradient(135deg,#539bf5,#a371f7)",
        isAll,
        true,
        () => selectStack(ALL_ID),
      ),
    );
    for (const s of visible) {
      const rel = formatRelativeTime(s.latestCommitAt);
      menu.append(
        menuItem(
          s.archived ? `${s.name} (archived)` : s.name,
          rel ? `${s.summary} · ${rel}` : s.summary,
          stackColor(s.id),
          s.id === id,
          false,
          () => selectStack(s.id),
        ),
      );
    }
    switcher.append(menu);
  }
  return switcher;
}

function repoMenuLabel() {
  const total = allRepos.length;
  const sel = state.selectedRepos.size;
  if (sel === 0) return "No repositories";
  if (sel >= total) return "All repositories";
  return `${sel} of ${total} repos`;
}

// A checkbox row in the repository filter. `indeterminate` renders the master
// "All repositories" box in its partial state when only some repos are selected.
function repoMenuItem(label, subtitle, checked, indeterminate, onChange) {
  const box = el("input", { type: "checkbox" });
  box.checked = checked;
  box.indeterminate = !!indeterminate;
  const row = el("label", {
    class: "dc-menu-item",
    style:
      "display:flex;align-items:center;gap:10px;width:100%;border-radius:6px;padding:8px 10px;cursor:pointer;text-align:left;",
  }, [
    box,
    el("span", {
      style: "display:flex;flex-direction:column;gap:2px;",
    }, [
      el("span", {
        style: `font:600 13px ${MONO};color:#e6edf3;`,
        text: label,
      }),
      subtitle
        ? el("span", {
          style: `font:400 11px ${MONO};color:#6e7681;`,
          text: subtitle,
        })
        : null,
    ]),
  ]);
  box.addEventListener("change", onChange);
  return row;
}

// Repository filter dropdown, styled like the stack switcher. Deselecting a repo
// narrows every view (via visibleStacks); the master row toggles select-all and
// select-none. Selection is written to per-tab sessionStorage on change.
function renderRepoFilter() {
  const wrap = el("div", { style: "position:relative;" });
  const btn = el("button", {
    class: "dc-switcher",
    type: "button",
    style:
      "display:inline-flex;align-items:center;gap:10px;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:8px 13px;cursor:pointer;",
  }, [
    el("span", {
      style: `font:700 15px ${SANS};color:#e6edf3;`,
      text: repoMenuLabel(),
    }),
    el("span", {
      style:
        `font:400 11px ${MONO};color:#6e7681;transition:transform .15s;transform:${
          state.repoOpen ? "rotate(180deg)" : "rotate(0deg)"
        };`,
      text: "▾",
    }),
  ]);
  btn.addEventListener("click", () => {
    state.repoOpen = !state.repoOpen;
    state.open = false;
    render();
  });
  wrap.append(btn);

  if (state.repoOpen) {
    const overlay = el("div", { style: "position:fixed;inset:0;z-index:10;" });
    overlay.addEventListener("click", () => {
      state.repoOpen = false;
      render();
    });
    wrap.append(overlay);
    const menu = el("div", {
      style:
        "position:absolute;top:calc(100% + 6px);left:0;z-index:20;background:#161b22;border:1px solid #30363d;border-radius:10px;padding:6px;min-width:300px;box-shadow:0 12px 32px rgba(0,0,0,.5);",
    });
    menu.append(el("div", {
      style:
        `font:600 10px ${MONO};color:#6e7681;text-transform:uppercase;letter-spacing:.06em;padding:6px 10px 8px;`,
      text: "Repositories",
    }));
    const total = allRepos.length;
    const sel = state.selectedRepos.size;
    menu.append(
      repoMenuItem(
        "All repositories",
        null,
        sel >= total && total > 0,
        sel > 0 && sel < total,
        () => {
          const next = sel >= total
            ? new Set()
            : new Set(allRepos.map((r) => r.path));
          state.selectedRepos = next;
          setSelectedRepos(next);
        },
      ),
    );
    for (const repo of allRepos) {
      const checked = state.selectedRepos.has(repo.path);
      menu.append(
        repoMenuItem(repo.name, repo.github, checked, false, () => {
          const next = new Set(state.selectedRepos);
          if (next.has(repo.path)) next.delete(repo.path);
          else next.add(repo.path);
          state.selectedRepos = next;
          setSelectedRepos(next);
        }),
      );
    }
    wrap.append(menu);
  }
  return wrap;
}

function render() {
  app.replaceChildren();
  const id = state.selectedId;
  const visible = visibleStacks();
  const isEmpty = visible.length === 0;
  const isAll = !isEmpty && id === "__all__";
  // Resolve the selected single stack from the full list so a deep-linked
  // archived stack still renders even while the "show archived" toggle is off,
  // then narrow its repos to the selection so the single-stack view respects the
  // repository filter just like the all-stacks view does.
  const selFull = (id !== "__all__")
    ? (stacks.find((s) => s.id === id) || null)
    : null;
  const sel = selFull
    ? (() => {
      const repos = selFull.repos.filter((r) =>
        state.selectedRepos.has(r.path)
      );
      return { ...selFull, repos, summary: repoSummary(repos) };
    })()
    : null;

  const header = el("div", { class: "app-header" });
  if (allRepos.length > 1) header.append(renderRepoFilter());
  header.append(renderHeaderSwitcher(isEmpty, isAll, sel, id, visible));

  const stackSummary = isEmpty
    ? ""
    : isAll
    ? `${visible.length} stack${visible.length === 1 ? "" : "s"}`
    : (sel ? sel.summary : "");
  header.append(
    el("span", {
      style: `font:400 12px ${MONO};color:#6e7681;`,
      text: stackSummary,
    }),
  );

  const tagWrap = el("span", {
    style:
      "margin-left:auto;display:inline-flex;gap:6px;flex-wrap:wrap;align-items:center;justify-content:flex-end;",
  });
  const scope = isAll ? visible : (sel ? [sel] : []);
  for (const t of headerCounts(scopeBranches(scope))) tagWrap.append(t);

  if (stacks.some((s) => s.archived)) {
    const toggle = el("label", {
      style:
        `display:inline-flex;align-items:center;gap:6px;margin-left:12px;cursor:pointer;font:400 12px ${MONO};color:#6e7681;`,
    });
    const box = el("input", { type: "checkbox" });
    box.checked = state.showArchived;
    box.addEventListener("change", () => setShowArchived(box.checked));
    toggle.append(box, el("span", { text: "Show archived" }));
    tagWrap.append(toggle);
  }

  header.append(tagWrap);
  app.append(header);

  if (allRepos.length > 0 && state.selectedRepos.size === 0) {
    app.append(emptyState(
      "No repositories selected",
      "Pick a repository from the filter above.",
    ));
    return;
  }
  if (isEmpty && !sel) {
    app.append(emptyState());
    return;
  }
  app.append(
    el("div", { class: "app-content" }, [
      sel && !isAll ? renderSingle(sel) : renderAll(visible),
    ]),
  );
}

// Resolve a path back to its {name, path} for the progress row label.
function loadRepoByPath(path) {
  return loadInfo.get(path) || { name: path, path };
}

// One progress row: state marker + repo name (+ error message when failed).
function loadRow(repo) {
  const s = loadState.get(repo.path) || "queued";
  let marker;
  if (s === "loading") {
    marker = el("span", { class: "repo-load-spinner" });
  } else if (s === "done") {
    marker = el("span", {
      style: "color:#3fb950;font-weight:600;flex:none;width:12px;",
      text: "✓",
    });
  } else if (s === "error") {
    marker = el("span", {
      style: "color:#ff7b72;font-weight:600;flex:none;width:12px;",
      text: "✗",
    });
  } else {
    marker = el("span", {
      style:
        "width:10px;height:10px;flex:none;border-radius:50%;background:#30363d;",
    });
  }
  const children = [
    marker,
    el("span", { style: "color:#e6edf3;", text: repo.name }),
  ];
  if (s === "error") {
    children.push(el("span", {
      style: "color:#ff7b72;font-size:11px;margin-left:auto;text-align:right;",
      text: loadError.get(repo.path) || "failed",
    }));
  } else {
    children.push(el("span", {
      style: "margin-left:auto;color:#6e7681;font-size:11px;",
      text: s,
    }));
  }
  return el("div", { class: "repo-load-row" }, children);
}

// Loading screen shown until every repository settles, then swapped for the
// real view (render()). One row per repository with a live state badge.
function renderLoading() {
  app.replaceChildren();
  const total = loadOrder.length;
  let done = 0;
  for (const path of loadOrder) {
    const s = loadState.get(path);
    if (s === "done" || s === "error") done++;
  }

  const wrap = el("div", { class: "app-content" });
  wrap.append(
    el("div", {
      style: `font:600 15px ${MONO};color:#e6edf3;margin-bottom:4px;`,
      text: total === 0
        ? "Loading repositories..."
        : `Loading ${total} ${total === 1 ? "repository" : "repositories"}`,
    }),
  );
  wrap.append(
    el("div", {
      style: `font:400 12px ${MONO};color:#6e7681;margin-bottom:16px;`,
      text: `${done} of ${total} loaded`,
    }),
  );

  const list = el("div", {
    style: "display:flex;flex-direction:column;gap:8px;",
  });
  for (const repo of loadOrder.map((p) => loadRepoByPath(p))) {
    list.append(loadRow(repo));
  }
  wrap.append(list);
  app.append(wrap);
}

// Rebuild the grouped model + repo list from a raw repositories array. Shared by
// the initial payload and live per-repo updates.
function buildFromRepos(repositories) {
  stacks = buildModel(repositories || []);
  allRepos = (repositories || [])
    .map((r) => ({
      name: r.name,
      path: r.path,
      github: r.github ? `${r.github.owner}/${r.github.repo}` : null,
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
    );
}

// Transient corner toast; auto-dismisses after ~3s. Multiple toasts stack.
function toast(message) {
  if (!toastHost) {
    toastHost = el("div", { class: "toast-host" });
    document.body.append(toastHost);
  }
  const node = el("div", { class: "toast", text: message });
  toastHost.append(node);
  requestAnimationFrame(() => node.classList.add("toast--show"));
  setTimeout(() => {
    node.classList.remove("toast--show");
    setTimeout(() => node.remove(), 250);
  }, 3000);
}

// Build the view model from the terminal payload, reconcile per-tab view state,
// swap the loading screen for the full stack view, and open the live channel.
function applyPayload(payload) {
  document.title = `stacked-prs${
    payload.rootDir ? ` · ${payload.rootDir}` : ""
  }`;
  reposByPath = new Map(
    (payload.repositories || []).map((r) => [r.path, r]),
  );
  buildFromRepos([...reposByPath.values()]);
  const present = new Set(allRepos.map((r) => r.path));
  let stored = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(REPOS_KEY) || "null");
  } catch {
    stored = null;
  }
  const restored = Array.isArray(stored)
    ? stored.filter((p) => present.has(p))
    : [];
  // Fall back to all-selected when nothing was stored or the stored set is stale
  // (e.g. a different folder set produced these paths), so the page never loads
  // blank on a meaningless selection.
  state.selectedRepos = restored.length > 0 ? new Set(restored) : present;
  if (
    state.selectedId !== ALL_ID &&
    !stacks.some((s) => s.id === state.selectedId)
  ) {
    state.selectedId = ALL_ID;
    setSelected(ALL_ID);
  }
  render();
  startWatch();
}

// Apply one live repo update: upsert (or drop, when it has no stacks) the repo
// in the raw map, rebuild the model, preserve the current selection (adding a
// newly appeared repo so it is visible), reconcile the selected stack, render,
// and toast.
function applyRepoUpdate(status) {
  if (!status || !status.path) return;
  const hasStacks = !!(status.status && status.status.stacks &&
    status.status.stacks.length);
  const isNew = !reposByPath.has(status.path);
  if (hasStacks) reposByPath.set(status.path, status);
  else reposByPath.delete(status.path);

  buildFromRepos([...reposByPath.values()]);

  const present = new Set(allRepos.map((r) => r.path));
  const next = new Set([...state.selectedRepos].filter((p) => present.has(p)));
  if (isNew && present.has(status.path)) next.add(status.path);
  state.selectedRepos = next;
  persistRepos(next);

  if (
    state.selectedId !== ALL_ID &&
    !stacks.some((s) => s.id === state.selectedId)
  ) {
    state.selectedId = ALL_ID;
    setSelected(ALL_ID);
  }
  render();
  toast(`${status.name || status.path} updated`);
}

// Open the live watch channel once, when the server enabled it. EventSource
// reconnects automatically on a dropped connection.
function startWatch() {
  if (watching) return;
  const cfg = globalThis.__STACKED_PRS__;
  if (!(cfg && cfg.watch)) return;
  watching = true;
  const es = new EventSource("/api/watch");
  es.addEventListener("repo-updated", (e) => {
    try {
      applyRepoUpdate(JSON.parse(e.data));
    } catch {
      // Ignore malformed updates; the next event or a reload recovers.
    }
  });
}

function loadStatus() {
  loadOrder = [];
  loadState.clear();
  loadError.clear();
  loadInfo.clear();
  renderLoading();

  const es = new EventSource("/api/status/stream");
  let completed = false;

  es.addEventListener("init", (e) => {
    const data = JSON.parse(e.data);
    const repos = data.repositories || [];
    loadOrder = repos.map((r) => r.path);
    for (const r of repos) {
      loadInfo.set(r.path, { name: r.name, path: r.path });
      loadState.set(r.path, "queued");
    }
    renderLoading();
  });

  es.addEventListener("repo-start", (e) => {
    const { path } = JSON.parse(e.data);
    loadState.set(path, "loading");
    renderLoading();
  });

  es.addEventListener("repo-done", (e) => {
    const { path } = JSON.parse(e.data);
    loadState.set(path, "done");
    renderLoading();
  });

  es.addEventListener("repo-error", (e) => {
    const { path, message } = JSON.parse(e.data);
    loadState.set(path, "error");
    loadError.set(path, message || "failed");
    renderLoading();
  });

  es.addEventListener("complete", (e) => {
    completed = true;
    es.close();
    applyPayload(JSON.parse(e.data));
  });

  // EventSource auto-reconnects on a dropped connection; surface a real error
  // only when we never received the terminal `complete` event.
  es.addEventListener("error", () => {
    if (completed) return;
    es.close();
    app.replaceChildren(el("div", {
      style: `padding:40px;color:#ff7b72;font:400 13px ${MONO};`,
      text: "Failed to load repository status.",
    }));
  });
}

loadStatus();
