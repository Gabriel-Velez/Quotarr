const state = {
  dashboard: null,
  settings: null,
  user: null,
  hoverDetails: new Map(),
  profilePages: {},
  localProfileOrder: [],
  draggedProfileId: null,
  dragInitialOrder: [],
  touchDragPointerId: null,
  touchHoverStart: null,
  hoverCardKey: null,
  selectedMedia: new Set(),
  reassignVisibleItems: [],
  reassignFilters: { query: "", requester: "all", type: "all", sort: "date-newest" },
  selectedDeleteMedia: new Set(),
  deleteVisibleItems: [],
  deleteFilters: { query: "", requester: "all", type: "all", sort: "date-newest" },
  deleteConfirm: false,
  deletedItems: [],
};
const byId = (id) => document.getElementById(id);
const NOTIFICATION_PROVIDERS = [
  {
    id: "email",
    name: "Email",
    fields: [
      ["host", "SMTP host", "text"],
      ["port", "SMTP port", "number"],
      ["secure", "Use SSL/TLS", "checkbox"],
      ["username", "SMTP username", "text", true],
      ["password", "SMTP password", "password", true],
      ["from", "From address", "email"],
      ["to", "Recipient address", "email"],
    ],
  },
  { id: "webPush", name: "Web Push", fields: [] },
  { id: "discord", name: "Discord", fields: [["webhookUrl", "Webhook URL", "url", true]] },
  {
    id: "gotify",
    name: "Gotify",
    fields: [["url", "Server URL", "url"], ["token", "Application token", "password", true]],
  },
  {
    id: "ntfy",
    name: "ntfy.sh",
    fields: [
      ["url", "Server URL", "url"],
      ["topic", "Topic", "text"],
      ["token", "Access token (optional)", "password", true],
    ],
  },
  { id: "pushbullet", name: "Pushbullet", fields: [["accessToken", "Access token", "password", true]] },
  {
    id: "pushover",
    name: "Pushover",
    fields: [["userKey", "User key", "password", true], ["apiToken", "API token", "password", true]],
  },
  { id: "slack", name: "Slack", fields: [["webhookUrl", "Incoming webhook URL", "url", true]] },
  {
    id: "telegram",
    name: "Telegram",
    fields: [["botToken", "Bot token", "password", true], ["chatId", "Chat ID", "text"]],
  },
  {
    id: "webhook",
    name: "Webhook",
    fields: [["url", "Webhook URL", "url", true], ["secret", "Bearer token (optional)", "password", true]],
  },
];
const SORT_OPTIONS = [
  ["date-newest", "Date added · newest"],
  ["date-oldest", "Date added · oldest"],
  ["size-biggest", "Size · biggest"],
  ["size-smallest", "Size · smallest"],
];

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent > 1 ? 1 : 0)} ${units[exponent]}`;
}

function formatStorageCap(gigabytes) {
  if (gigabytes >= 1000) {
    return `${Number((gigabytes / 1000).toFixed(1))} TB`;
  }
  return `${gigabytes} GB`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function showNotice(target, message, kind = "error") {
  target.textContent = message;
  target.className = `notice ${kind}`;
  target.hidden = !message;
}

function buildNotificationProviders() {
  const menu = byId("notification-service-menu");
  NOTIFICATION_PROVIDERS.forEach((provider) => {
    const option = document.createElement("button");
    option.className = "notification-service-option";
    option.type = "button";
    option.dataset.addNotificationProvider = provider.id;
    option.textContent = provider.name;
    menu.append(option);
  });
}

buildNotificationProviders();

function addNotificationProvider(providerId, config = {}) {
  const definition = NOTIFICATION_PROVIDERS.find((provider) => provider.id === providerId);
  if (!definition) return;
  const instanceId = config.instanceId || crypto.randomUUID();
  const card = document.createElement("article");
  card.className = "notification-card";
  card.dataset.provider = providerId;
  card.dataset.instanceId = instanceId;

  const heading = document.createElement("div");
  heading.className = "notification-card-heading";
  const name = document.createElement("h3");
  name.dataset.instanceTitle = "";
  const headingActions = document.createElement("div");
  headingActions.className = "notification-card-actions";
  const enabledLabel = document.createElement("label");
  enabledLabel.className = "notification-enable";
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.dataset.providerEnabled = instanceId;
  enabled.checked = config.enabled === true;
  const enabledText = document.createElement("span");
  enabledText.textContent = "Enable";
  enabledLabel.append(enabled, enabledText);
  const remove = document.createElement("button");
  remove.className = "notification-remove";
  remove.type = "button";
  remove.dataset.removeNotification = "";
  remove.setAttribute("aria-label", `Remove ${definition.name} service`);
  remove.textContent = "Remove";
  headingActions.append(enabledLabel, remove);
  heading.append(name, headingActions);

  const status = document.createElement("p");
  status.className = "service-status notification-provider-status";
  status.dataset.providerStatus = instanceId;
  status.textContent = providerId === "webPush" ? "No browser subscriptions" : "Not configured";
  card.append(heading, status);
  if (providerId === "webPush") {
    const help = document.createElement("p");
    help.className = "notification-help";
    help.textContent = "Subscribe this browser to receive alerts here.";
    const subscribe = document.createElement("button");
    subscribe.className = "button button-secondary";
    subscribe.type = "button";
    subscribe.dataset.webPushAction = "subscribe";
    subscribe.dataset.instanceId = instanceId;
    subscribe.textContent = "Enable on this browser";
    const unsubscribe = document.createElement("button");
    unsubscribe.className = "button button-secondary";
    unsubscribe.type = "button";
    unsubscribe.dataset.webPushAction = "unsubscribe";
    unsubscribe.dataset.instanceId = instanceId;
    unsubscribe.textContent = "Remove browser from service";
    card.append(help, subscribe, unsubscribe);
  }

  const fields = document.createElement("div");
  fields.className = "notification-fields";
  definition.fields.forEach(([key, labelText, type, secret]) => {
    const label = document.createElement("label");
    label.className = "notification-field";
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = type;
    input.dataset.notificationField = key;
    input.dataset.instanceId = instanceId;
    input.autocomplete = secret ? "new-password" : "off";
    if (secret) input.placeholder = "Leave blank to keep saved secret";
    label.append(input);
    fields.append(label);
  });
  card.append(fields);

  const test = document.createElement("button");
  test.className = "button button-secondary notification-test";
  test.type = "button";
  test.dataset.testProvider = providerId;
  test.dataset.instanceId = instanceId;
  test.textContent = "Send test";
  card.append(test);
  byId("notification-providers").append(card);
  updateNotificationProviderTitles();
  return card;
}

function updateNotificationProviderTitles() {
  const cardsByProvider = new Map();
  byId("notification-providers").querySelectorAll(".notification-card").forEach((card) => {
    const providerId = card.dataset.provider;
    if (!cardsByProvider.has(providerId)) cardsByProvider.set(providerId, []);
    cardsByProvider.get(providerId).push(card);
  });
  cardsByProvider.forEach((cards, providerId) => {
    const name = NOTIFICATION_PROVIDERS.find((provider) => provider.id === providerId).name;
    cards.forEach((card, index) => {
      card.querySelector("[data-instance-title]").textContent =
        cards.length > 1 ? `${name} ${index + 1}` : name;
    });
  });
}

function renderUpdateInfo(update) {
  const notice = byId("update-notice");
  if (update.isUpToDate) {
    const summary = document.createElement("p");
    summary.textContent = `Quotarr ${update.currentVersion} is up to date.`;
    notice.replaceChildren(summary);
    notice.className = "notice success update-notice";
    notice.hidden = false;
    return;
  }
  const summary = document.createElement("p");
  summary.className = "update-summary";
  summary.textContent =
    `Latest GitHub commit (Quotarr ${update.currentVersion}): ${update.commit.message} · ${formatDate(update.commit.date)}`;
  const link = document.createElement("a");
  link.href = update.commit.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "View commit on GitHub";
  const instructions = document.createElement("p");
  instructions.textContent = `To update this ${update.deploymentType} installation, stop Quotarr and run:`;
  const command = document.createElement("code");
  command.className = "update-command";
  command.textContent = update.updateCommand;
  const note = document.createElement("p");
  note.className = "update-note";
  note.textContent = "This check only reads GitHub information; it does not install or restart Quotarr.";
  notice.replaceChildren(summary, link, instructions, command, note);
  notice.className = "notice success update-notice";
  notice.hidden = false;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The server returned an invalid response.");
  }
  if (!response.ok) {
    if (response.status === 401 && url !== "/api/login" && url !== "/api/session") {
      showLogin("Your Seerr sign-in expired. Sign in again to continue.");
    }
    throw new Error(result.error || `Request failed (${response.status}).`);
  }
  return result;
}

function setView(view) {
  byId("login-view").hidden = view !== "login";
  byId("dashboard-view").hidden = view !== "dashboard";
  byId("settings-view").hidden = view !== "settings";
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === view);
  });
}

function closeMobileMenu() {
  byId("header-menu").classList.remove("open");
  byId("mobile-menu-toggle").setAttribute("aria-expanded", "false");
  byId("mobile-menu-toggle").setAttribute("aria-label", "Open menu");
}

byId("mobile-menu-toggle").addEventListener("click", () => {
  const isOpen = byId("mobile-menu-toggle").getAttribute("aria-expanded") === "true";
  byId("header-menu").classList.toggle("open", !isOpen);
  byId("mobile-menu-toggle").setAttribute("aria-expanded", String(!isOpen));
  byId("mobile-menu-toggle").setAttribute("aria-label", isOpen ? "Open menu" : "Close menu");
});
byId("header-menu").addEventListener("click", (event) => {
  if (event.target.closest("button")) closeMobileMenu();
});
document.addEventListener("pointerdown", (event) => {
  if (!byId("header-menu").classList.contains("open")) return;
  if (
    byId("header-menu").contains(event.target) ||
    byId("mobile-menu-toggle").contains(event.target)
  )
    return;
  closeMobileMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMobileMenu();
});
window.addEventListener("resize", () => {
  if (window.innerWidth > 600) closeMobileMenu();
});

function showLogin(message = "") {
  state.user = null;
  closeMobileMenu();
  state.settings = null;
  state.localProfileOrder = [];
  state.selectedMedia.clear();
  state.selectedDeleteMedia.clear();
  state.deletedItems = [];
  state.deleteConfirm = false;
  state.reassignVisibleItems = [];
  ["seerr", "radarr", "sonarr"].forEach((name) => {
    byId(`${name}-url`).value = "";
    byId(`${name}-key`).value = "";
    byId(`${name}-status`).textContent = "Not configured";
    byId(`${name}-status`).classList.remove("configured");
  });
  document.querySelectorAll("[data-notification-field]").forEach((input) => {
    if (input.type === "checkbox") input.checked = false;
    else input.value = "";
  });
  document.querySelectorAll("[data-provider-enabled]").forEach((input) => {
    input.checked = false;
  });
  byId("notification-threshold").value = "80";
  byId("notification-full").checked = true;
  byId("notification-enabled").checked = true;
  updateNotificationSettingsEnabled();
  byId("default-category").value = "Unrequested";
  byId("page-size").value = "25";
  byId("cap-list").replaceChildren();
  byId("profile-count").textContent = "0 profiles";
  byId("reassign-search").value = "";
  byId("reassign-requester").replaceChildren();
  byId("reassign-list").replaceChildren();
  byId("reassign-count").textContent = "0 titles";
  byId("delete-search").value = "";
  byId("delete-requester").replaceChildren();
  byId("delete-list").replaceChildren();
  byId("deleted-media-list").replaceChildren();
  byId("delete-count").textContent = "0 titles";
  byId("deleted-media-count").textContent = "0 titles";
  byId("deleted-media-details").open = false;
  byId("delete-from-arr").checked = false;
  byId("delete-files").checked = false;
  byId("delete-files").disabled = true;
  showNotice(byId("settings-notice"), "");
  byId("navigation").hidden = true;
  byId("refresh-group").hidden = true;
  byId("user-session").hidden = true;
  byId("mobile-menu-toggle").hidden = true;
  byId("settings-tab").hidden = true;
  setView("login");
  showNotice(byId("login-notice"), message);
  showNotice(byId("update-notice"), "");
}

async function enterApp(user) {
  state.user = user;
  state.localProfileOrder = readLocalProfileOrder(user);
  byId("navigation").hidden = false;
  byId("refresh-group").hidden = false;
  byId("user-session").hidden = false;
  byId("mobile-menu-toggle").hidden = false;
  byId("user-name").textContent = `${user.name}${user.isAdmin ? " · Admin" : ""}`;
  byId("settings-tab").hidden = !user.isAdmin;
  setView("dashboard");
  await refreshDashboard(true);
}

function renderSummary(profiles, items, requests) {
  const total = items.reduce((sum, item) => sum + item.size, 0);
  const requested = items.filter((item) => item.profileId !== "default").length;
  const movies = items.filter((item) => item.type === "Movie").length;
  const shows = items.length - movies;
  const seerrRequests = requests.filter((request) => !request.manuallyAssigned);
  byId("summary").replaceChildren(
    summaryCard("Total storage", formatBytes(total), `${items.length} titles in the library`, "◩"),
    summaryCard(
      "Requested",
      String(seerrRequests.length),
      `Across ${Math.max(profiles.length - 1, 0)} Seerr profiles`,
      "◎",
    ),
    summaryCard("Movies & shows", `${movies} / ${shows}`, "From Radarr and Sonarr", "▧"),
  );
}

function summaryCard(label, value, note, icon) {
  const card = document.createElement("article");
  card.className = "summary-card";
  const badge = document.createElement("span");
  badge.className = "summary-icon";
  badge.textContent = icon;
  const heading = document.createElement("p");
  heading.className = "summary-label";
  heading.textContent = label;
  const amount = document.createElement("strong");
  amount.className = "summary-value";
  amount.textContent = value;
  const caption = document.createElement("p");
  caption.className = "summary-note";
  caption.textContent = note;
  card.append(badge, heading, amount, caption);
  return card;
}

function readLocalProfileOrder(user) {
  try {
    const saved = localStorage.getItem(`storage-tally-profile-order:${user.id}`);
    const order = saved ? JSON.parse(saved) : [];
    return Array.isArray(order)
      ? [...new Set(order.map(String).filter((id) => id && id !== "default" && id.length <= 100))]
      : [];
  } catch (error) {
    showNotice(
      byId("notice"),
      `Could not load this browser's saved profile order: ${error.message}`,
    );
    return [];
  }
}

function orderedProfiles(profiles) {
  const users = profiles.filter((profile) => profile.id !== "default");
  if (!state.user?.isAdmin && state.localProfileOrder.length) {
    const ranks = new Map(state.localProfileOrder.map((id, index) => [id, index]));
    users.sort((a, b) => {
      const aRank = ranks.get(a.id);
      const bRank = ranks.get(b.id);
      if (aRank == null && bRank == null) return 0;
      if (aRank == null) return 1;
      if (bRank == null) return -1;
      return aRank - bRank;
    });
  }
  const currentUserIndex = users.findIndex((profile) => profile.id === String(state.user?.id));
  if (currentUserIndex > 0) users.unshift(users.splice(currentUserIndex, 1)[0]);
  const defaultProfile = profiles.find((profile) => profile.id === "default");
  return defaultProfile ? [...users, defaultProfile] : users;
}

function renderUsageBar(bar, items) {
  bar.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("span");
    empty.className = "bar-empty";
    empty.textContent = "No media assigned to this profile";
    bar.append(empty);
    return;
  }
  items.forEach((item) => {
    const segment = document.createElement("div");
    segment.className = "usage-segment media-entry";
    segment.dataset.hoverKey = `item:${item.key}`;
    segment.setAttribute("role", "img");
    segment.setAttribute("aria-label", `${item.title} · ${item.type} · ${formatBytes(item.size)}`);
    if (item.poster) {
      const image = document.createElement("img");
      image.className = "segment-image";
      image.src = item.poster;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      segment.append(image);
    }
    bar.append(segment);
  });
}

function makeProfileCard(profile, data) {
  const { items, requests, caps, pageSize } = data;
  const libraryItems = items.filter((item) => item.inLibrary && item.profileId === profile.id);
  const profileSort = state.profilePages[profile.id]?.sort || "date-newest";
  const total = libraryItems.reduce((sum, item) => sum + item.size, 0);
  const capGb = Number(caps?.[profile.id]) || 0;
  const capBytes = capGb > 0 ? capGb * 1024 ** 3 : 0;
  const percent = capBytes ? Math.min((total / capBytes) * 100, 100) : 0;
  const card = document.createElement("article");
  card.className = "profile-card";
  card.dataset.profileId = profile.id;

  const head = document.createElement("div");
  head.className = "profile-head";
  const titleGroup = document.createElement("div");
  titleGroup.className = "profile-title-group";
  if (profile.id !== "default") {
    const dragHandle = document.createElement("button");
    dragHandle.className = "profile-drag-handle";
    dragHandle.type = "button";
    dragHandle.draggable = true;
    dragHandle.setAttribute("aria-label", `Drag to reorder ${profile.name}`);
    dragHandle.title = `Drag to reorder ${profile.name}`;
    titleGroup.append(dragHandle);
  }
  const dot = document.createElement("span");
  dot.className = `profile-dot ${profile.id === "default" ? "default-dot" : ""}`;
  const title = document.createElement("h3");
  title.textContent = profile.name;
  titleGroup.append(dot, title);
  const totalLabel = document.createElement("strong");
  totalLabel.textContent = formatBytes(total);
  const sort = document.createElement("select");
  sort.className = "profile-sort";
  sort.setAttribute("aria-label", `Sort ${profile.name} media`);
  SORT_OPTIONS.forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    sort.append(option);
  });
  sort.value = profileSort;
  const toggle = document.createElement("button");
  toggle.className = "expand-toggle";
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", `Show ${profile.name} request list`);
  const chevron = document.createElement("span");
  chevron.className = "chevron-icon";
  chevron.setAttribute("aria-hidden", "true");
  toggle.append(chevron);
  head.append(titleGroup, totalLabel, sort, toggle);

  const progressWrap = document.createElement("div");
  progressWrap.className = "progress-wrap";
  const progress = document.createElement("div");
  progress.className = "progress-track";
  const fill = document.createElement("div");
  fill.className = `progress-fill ${capBytes && total > capBytes ? "over-cap" : ""}`;
  fill.style.width = `${percent}%`;
  progress.append(fill);
  const progressText = document.createElement("span");
  progressText.textContent = capBytes
    ? `${percent.toFixed(0)}% of ${formatStorageCap(capGb)}`
    : "No storage cap set";
  progressWrap.append(progress, progressText);

  const barScroll = document.createElement("div");
  barScroll.className = "bar-scroll";
  const bar = document.createElement("div");
  bar.className = "usage-bar";
  renderUsageBar(bar, sortMediaEntries(libraryItems, profileSort));
  barScroll.append(bar);

  const details = document.createElement("div");
  details.className = "profile-details";
  details.hidden = true;
  const entries =
    profile.id === "default"
      ? libraryItems.map((item) => ({
          id: item.key,
          title: item.title,
          type: item.type,
          size: item.size,
          poster: item.poster,
          dateRequested: item.dateRequested,
          dateReleased: item.dateReleased,
          inLibrary: true,
        }))
      : requests.filter(
          (request) =>
            request.profileId === profile.id && !request.title.toLowerCase().startsWith("untitled"),
        );
  const drawEntries = renderEntryList(details, entries, pageSize, profile.id);
  sort.addEventListener("change", () => {
    const saved = state.profilePages[profile.id] || { query: "", page: 1 };
    state.profilePages[profile.id] = { ...saved, sort: sort.value, page: 1 };
    renderUsageBar(bar, sortMediaEntries(libraryItems, sort.value));
    drawEntries();
  });
  toggle.addEventListener("click", () => {
    const isOpen = !details.hidden;
    details.hidden = isOpen;
    toggle.setAttribute("aria-expanded", String(!isOpen));
  });

  card.append(head, progressWrap, barScroll, details);
  return card;
}

function renderEntryList(container, entries, pageSize, stateKey) {
  const saved = state.profilePages[stateKey] || { query: "", page: 1, sort: "date-newest" };
  const toolbar = document.createElement("div");
  toolbar.className = "request-toolbar";
  const heading = document.createElement("p");
  heading.className = "eyebrow";
  heading.textContent = stateKey === "default" ? "MEDIA IN DEFAULT CATEGORY" : "REQUEST HISTORY";
  const search = document.createElement("input");
  search.type = "search";
  search.className = "entry-search";
  search.placeholder = "Search this list";
  search.value = saved.query;
  search.setAttribute("aria-label", `Search ${stateKey} media`);
  toolbar.append(heading, search);

  const rowList = document.createElement("div");
  rowList.className = "request-entries";
  const pagination = document.createElement("div");
  pagination.className = "pagination";
  container.replaceChildren(toolbar, rowList, pagination);

  const draw = () => {
    const current = state.profilePages[stateKey] || { query: "", page: 1 };
    const filtered = entries.filter((entry) =>
      entry.title.toLowerCase().includes(current.query.toLowerCase()),
    );
    const sorted = sortMediaEntries(filtered, current.sort || "date-newest");
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    current.page = Math.min(current.page, pages);
    state.profilePages[stateKey] = current;
    rowList.replaceChildren();
    sorted
      .slice((current.page - 1) * pageSize, current.page * pageSize)
      .forEach((entry) => rowList.append(makeRequestRow(entry)));
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "list-empty";
      empty.textContent = entries.length
        ? "No requests match this search."
        : "No requests to show.";
      rowList.append(empty);
    }
    renderPagination(pagination, current.page, pages, filtered.length, (page) => {
      current.page = page;
      draw();
    });
  };
  search.addEventListener("input", () => {
    state.profilePages[stateKey] = {
      ...state.profilePages[stateKey],
      query: search.value.trim(),
      page: 1,
    };
    draw();
  });
  draw();
  return draw;
}

function sortMediaEntries(entries, sortBy) {
  const sorted = [...entries];
  if (sortBy.startsWith("date-")) {
    const direction = sortBy === "date-oldest" ? 1 : -1;
    sorted.sort((a, b) => {
      const aDate = Date.parse(a.dateRequested || "");
      const bDate = Date.parse(b.dateRequested || "");
      const aMissing = !Number.isFinite(aDate);
      const bMissing = !Number.isFinite(bDate);
      if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
      return (aDate - bDate) * direction;
    });
  } else {
    const direction = sortBy === "size-smallest" ? 1 : -1;
    sorted.sort((a, b) => ((Number(a.size) || 0) - (Number(b.size) || 0)) * direction);
  }
  return sorted;
}

function renderPagination(container, currentPage, pageCount, resultCount, onChange) {
  const summary = document.createElement("span");
  summary.textContent = `${resultCount} entries · page ${currentPage} of ${pageCount}`;
  const buttons = document.createElement("div");
  buttons.className = "page-buttons";
  const previous = document.createElement("button");
  previous.type = "button";
  previous.className = "page-button";
  previous.textContent = "Previous";
  previous.disabled = currentPage <= 1;
  previous.addEventListener("click", () => onChange(currentPage - 1));
  buttons.append(previous);

  const pageNumbers = new Set([1, pageCount]);
  for (
    let page = Math.max(1, currentPage - 2);
    page <= Math.min(pageCount, currentPage + 2);
    page += 1
  ) {
    pageNumbers.add(page);
  }
  let last = 0;
  [...pageNumbers]
    .sort((a, b) => a - b)
    .forEach((page) => {
      if (page - last > 1) {
        const dots = document.createElement("span");
        dots.className = "page-ellipsis";
        dots.textContent = "…";
        buttons.append(dots);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = `page-button ${page === currentPage ? "current" : ""}`;
      button.textContent = String(page);
      button.setAttribute("aria-label", `Page ${page}`);
      button.setAttribute("aria-current", page === currentPage ? "page" : "false");
      button.addEventListener("click", () => onChange(page));
      buttons.append(button);
      last = page;
    });
  const next = document.createElement("button");
  next.type = "button";
  next.className = "page-button";
  next.textContent = "Next";
  next.disabled = currentPage >= pageCount;
  next.addEventListener("click", () => onChange(currentPage + 1));
  buttons.append(next);
  container.replaceChildren(summary, buttons);
}

function makeThumb(url, className = "entry-thumb") {
  const thumb = document.createElement("span");
  thumb.className = className;
  if (url) {
    const image = document.createElement("img");
    image.src = url;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    thumb.append(image);
  }
  return thumb;
}

function makeRequestRow(entry) {
  const row = document.createElement("article");
  row.className = "request-entry media-entry";
  const primary = document.createElement("div");
  primary.className = "entry-primary";
  primary.append(makeThumb(entry.poster));
  const title = document.createElement("div");
  title.className = "entry-title";
  const name = document.createElement("strong");
  name.textContent = entry.title;
  const meta = document.createElement("span");
  meta.textContent = entry.manuallyAssigned
    ? `${entry.type} · Manually assigned · No Seerr request`
    : `${entry.type} · ${entry.inLibrary ? "In library" : "Not downloaded"}`;
  title.append(name, meta);
  primary.append(title);
  const requestDate = document.createElement("span");
  requestDate.className = "entry-date";
  requestDate.textContent = formatDate(entry.dateRequested);
  const size = document.createElement("strong");
  size.className = "entry-size";
  size.textContent = entry.inLibrary ? formatBytes(entry.size) : "Not downloaded";
  row.append(primary, requestDate, size);
  return row;
}

function renderDashboard(data) {
  state.dashboard = data;
  state.deletedItems = data.deletedItems || [];
  state.hoverDetails = new Map();
  data.items.forEach((item) => state.hoverDetails.set(`item:${item.key}`, item));
  byId("empty-state").hidden = true;
  byId("profiles").replaceChildren();
  renderSummary(data.profiles, data.items, data.requests);
  orderedProfiles(data.profiles).forEach((profile) => {
    byId("profiles").append(makeProfileCard(profile, data));
  });
  byId("last-updated").textContent =
    `Synced ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  if (state.user?.isAdmin) renderCapList(data.profiles, data.caps);
  if (state.user?.isAdmin) renderReassignList();
  if (state.user?.isAdmin) renderDeleteList();
}

async function refreshDashboard(showErrors = true) {
  const refresh = byId("refresh-button");
  refresh.disabled = true;
  showNotice(byId("notice"), "");
  try {
    renderDashboard(await api("/api/dashboard"));
    byId("empty-state").hidden = true;
  } catch (error) {
    if (showErrors) showNotice(byId("notice"), error.message);
  } finally {
    refresh.disabled = false;
  }
}

function renderCapList(profiles, caps = {}) {
  byId("profile-count").textContent =
    `${profiles.length} ${profiles.length === 1 ? "profile" : "profiles"}`;
  const list = byId("cap-list");
  list.replaceChildren();
  profiles.forEach((profile) => {
    const row = document.createElement("label");
    row.className = "cap-row";
    const name = document.createElement("span");
    name.textContent = profile.name;
    const inputWrap = document.createElement("span");
    inputWrap.className = "cap-input-wrap";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "1";
    input.value = caps[profile.id] || "";
    input.placeholder = "No cap";
    input.dataset.profile = profile.id;
    input.setAttribute("aria-label", `${profile.name} storage cap in GB`);
    const suffix = document.createElement("span");
    suffix.textContent = "GB";
    inputWrap.append(input, suffix);
    row.append(name, inputWrap);
    list.append(row);
  });
}

function loadNotificationSettings() {
  const notifications = state.settings.notifications;
  byId("notification-enabled").checked = notifications.enabled !== false;
  updateNotificationSettingsEnabled();
  byId("notification-threshold").value = String(notifications.thresholdPercent || 80);
  byId("notification-full").checked = notifications.notifyFull !== false;
  const container = byId("notification-providers");
  container.replaceChildren();
  NOTIFICATION_PROVIDERS.forEach((definition) => {
    (notifications.providers[definition.id] || []).forEach((config) => {
      const card = addNotificationProvider(definition.id, config);
      card.querySelector(`[data-provider-enabled="${config.instanceId}"]`).checked = config.enabled === true;
      definition.fields.forEach(([field, , type, secret]) => {
        const input = card.querySelector(`[data-notification-field="${field}"]`);
        if (type === "checkbox") {
          input.checked = config[field] === true;
        } else if (secret) {
          input.value = "";
          input.placeholder = config.configured
            ? "Saved — leave blank to keep"
            : "Enter value";
        } else {
          input.value = config[field] ?? "";
        }
      });
      const status = card.querySelector(`[data-provider-status="${config.instanceId}"]`);
      status.textContent = config.configured
        ? `${config.enabled ? "Enabled" : "Configured, disabled"}${definition.id === "webPush" ? ` · ${config.subscriptionCount} browser${config.subscriptionCount === 1 ? "" : "s"}` : ""}`
        : definition.id === "webPush"
          ? "No browser subscriptions"
          : "Not configured";
      status.classList.toggle("configured", Boolean(config.configured && config.enabled));
    });
  });
}

function updateNotificationSettingsEnabled() {
  byId("notification-options").disabled = !byId("notification-enabled").checked;
}

function notificationSettingsFromForm() {
  const providers = Object.fromEntries(NOTIFICATION_PROVIDERS.map(({ id }) => [id, []]));
  byId("notification-providers").querySelectorAll(".notification-card").forEach((card) => {
    const definition = NOTIFICATION_PROVIDERS.find((provider) => provider.id === card.dataset.provider);
    const instanceId = card.dataset.instanceId;
    const provider = {
      instanceId,
      enabled: card.querySelector(`[data-provider-enabled="${instanceId}"]`).checked,
    };
    definition.fields.forEach(([field, , type]) => {
      const input = card.querySelector(`[data-notification-field="${field}"]`);
      provider[field] = type === "checkbox" ? input.checked : input.value.trim();
    });
    providers[definition.id].push(provider);
  });
  return {
    enabled: byId("notification-enabled").checked,
    thresholdPercent: Number(byId("notification-threshold").value),
    notifyFull: byId("notification-full").checked,
    providers,
  };
}

async function loadSettings() {
  state.settings = await api("/api/settings");
  ["seerr", "radarr", "sonarr"].forEach((name) => {
    const service = state.settings.services[name];
    byId(`${name}-url`).value = service.url || "";
    byId(`${name}-status`).textContent = service.configured
      ? "API key saved"
      : "API key not configured";
    byId(`${name}-status`).classList.toggle("configured", service.configured);
  });
  byId("default-category").value = state.settings.defaultCategory || "Unrequested";
  byId("page-size").value = String(state.settings.pageSize || 25);
  renderCapList(state.dashboard?.profiles || [], state.settings.caps);
  loadNotificationSettings();
}

async function saveSettings(sync) {
  showNotice(byId("settings-notice"), "");
  const caps = Object.fromEntries(
    [...document.querySelectorAll("[data-profile]")]
      .map((input) => [input.dataset.profile, input.value])
      .filter(([, value]) => value !== ""),
  );
  const services = Object.fromEntries(
    ["seerr", "radarr", "sonarr"].map((name) => [
      name,
      { url: byId(`${name}-url`).value.trim(), apiKey: byId(`${name}-key`).value.trim() },
    ]),
  );
  try {
    state.settings = await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        services,
        defaultCategory: byId("default-category").value,
        caps,
        pageSize: Number(byId("page-size").value),
        notifications: notificationSettingsFromForm(),
      }),
    });
    ["seerr", "radarr", "sonarr"].forEach((name) => {
      byId(`${name}-key`).value = "";
      const configured = state.settings.services[name].configured;
      byId(`${name}-status`).textContent = configured ? "API key saved" : "API key not configured";
      byId(`${name}-status`).classList.toggle("configured", configured);
    });
    loadNotificationSettings();
    if (sync) {
      renderDashboard(await api("/api/dashboard"));
      showNotice(byId("settings-notice"), "Settings saved and Seerr profiles synced.", "success");
    } else {
      showNotice(byId("settings-notice"), "Settings saved.", "success");
    }
    return true;
  } catch (error) {
    showNotice(byId("settings-notice"), error.message);
    return false;
  }
}

function base64UrlToBytes(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function subscribeBrowserForPush(instanceId) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    throw new Error("This browser does not support Web Push notifications.");
  }
  const card = [...byId("notification-providers").querySelectorAll(".notification-card")]
    .find((entry) => entry.dataset.instanceId === instanceId);
  if (!card) throw new Error("That Web Push service is no longer available.");
  card.querySelector(`[data-provider-enabled="${instanceId}"]`).checked = true;
  if (!(await saveSettings(false))) return;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Allow notifications in your browser to enable Web Push.");
  const registration = await navigator.serviceWorker.register("/service-worker.js");
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const publicKey = state.settings.notifications.webPushPublicKey;
    if (!publicKey) throw new Error("The Web Push public key is unavailable. Reload Settings and try again.");
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey),
    });
  }
  const result = await api("/api/notifications/subscription", {
    method: "POST",
    body: JSON.stringify({ instanceId, subscription: subscription.toJSON() }),
  });
  state.settings.notifications.providers.webPush = [
    ...state.settings.notifications.providers.webPush.filter((provider) => provider.instanceId !== instanceId),
    result.provider,
  ];
  loadNotificationSettings();
  showNotice(byId("settings-notice"), "Web Push is enabled for this browser.", "success");
}

async function unsubscribeBrowserFromPush(instanceId) {
  const registration = await navigator.serviceWorker.getRegistration("/service-worker.js");
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) throw new Error("This browser does not have a Web Push subscription.");
  const result = await api("/api/notifications/subscription", {
    method: "DELETE",
    body: JSON.stringify({ instanceId, endpoint: subscription.endpoint }),
  });
  if (result.unsubscribeBrowser) await subscription.unsubscribe();
  await loadSettings();
  showNotice(byId("settings-notice"), "Web Push was removed from this service.", "success");
}

async function testNotificationProvider(provider, instanceId) {
  if (!(await saveSettings(false))) return;
  try {
    await api("/api/notifications/test", {
      method: "POST",
      body: JSON.stringify({ provider, instanceId }),
    });
    showNotice(byId("settings-notice"), "Test notification sent.", "success");
  } catch (error) {
    showNotice(byId("settings-notice"), error.message);
  }
}

function makeAssignmentRow(item, profiles) {
  const row = document.createElement("article");
  row.className = "media-row media-entry";
  const checkboxTarget = document.createElement("label");
  checkboxTarget.className = "media-select-target";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "media-select-checkbox reassign-media-select-checkbox";
  checkbox.checked = state.selectedMedia.has(item.key);
  checkbox.setAttribute("aria-label", `Select ${item.title} for bulk reassignment`);
  checkboxTarget.append(checkbox);
  row.classList.toggle("selected", checkbox.checked);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.selectedMedia.add(item.key);
    else state.selectedMedia.delete(item.key);
    row.classList.toggle("selected", checkbox.checked);
    updateBulkSelectionSummary();
  });
  const primary = document.createElement("div");
  primary.className = "entry-primary";
  primary.addEventListener("click", () => checkbox.click());
  primary.append(makeThumb(item.poster));
  const title = document.createElement("div");
  title.className = "entry-title";
  const name = document.createElement("strong");
  name.textContent = item.title;
  const requester = profiles.find((profile) => profile.id === item.requesterProfileId);
  const meta = document.createElement("span");
  meta.textContent = `${formatBytes(item.size)} · ${item.type} · ${requester?.name || "No Seerr request"} · ${item.dateRequested ? formatDate(item.dateRequested) : "No request date"} `;
  title.append(name, meta);
  primary.append(title);

  const select = document.createElement("select");
  select.setAttribute("aria-label", `Assign ${item.title} to profile`);
  profiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    option.selected = profile.id === item.profileId;
    select.append(option);
  });
  select.addEventListener("change", () => assignItem(item.key, select.value, select));
  row.append(checkboxTarget, primary, select);
  return row;
}

function renderBulkProfileSelect(profiles) {
  const select = byId("bulk-profile");
  const previous = select.value;
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a profile";
  select.append(placeholder);
  profiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    select.append(option);
  });
  select.value = profiles.some((profile) => profile.id === previous) ? previous : "";
}

function updateBulkSelectionSummary() {
  const visibleItems = state.reassignVisibleItems;
  const selectedVisible = visibleItems.reduce(
    (count, item) => count + Number(state.selectedMedia.has(item.key)),
    0,
  );
  const selectAll = byId("select-filtered");
  selectAll.checked = visibleItems.length > 0 && selectedVisible === visibleItems.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleItems.length;
  selectAll.disabled = visibleItems.length === 0;
  byId("bulk-selected-count").textContent = `${state.selectedMedia.size} selected`;
  byId("bulk-assign-button").disabled =
    state.selectedMedia.size === 0 || !byId("bulk-profile").value;
  byId("clear-selection").disabled = state.selectedMedia.size === 0;
}

function renderReassignList() {
  const list = byId("reassign-list");
  if (!list || !state.dashboard) return;
  const { profiles, items } = state.dashboard;
  const availableKeys = new Set(items.map((item) => item.key));
  state.selectedMedia = new Set([...state.selectedMedia].filter((key) => availableKeys.has(key)));
  renderBulkProfileSelect(profiles);
  const requesterSelect = byId("reassign-requester");
  const selectedRequester = state.reassignFilters.requester;
  requesterSelect.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "Everyone";
  requesterSelect.append(allOption);
  const noneOption = document.createElement("option");
  noneOption.value = "none";
  noneOption.textContent = "No Seerr request";
  requesterSelect.append(noneOption);
  profiles
    .filter((profile) => profile.id !== "default")
    .forEach((profile) => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.name;
      requesterSelect.append(option);
    });
  requesterSelect.value = [...requesterSelect.options].some(
    (option) => option.value === selectedRequester,
  )
    ? selectedRequester
    : "all";
  byId("reassign-search").value = state.reassignFilters.query;
  byId("reassign-type").value = state.reassignFilters.type;
  byId("reassign-sort").value = state.reassignFilters.sort;

  let filtered = items.filter((item) => {
    const matchesText = item.title
      .toLowerCase()
      .includes(state.reassignFilters.query.trim().toLowerCase());
    const matchesRequester =
      state.reassignFilters.requester === "all" ||
      (state.reassignFilters.requester === "none"
        ? !item.requesterProfileId
        : item.requesterProfileId === state.reassignFilters.requester);
    const matchesType =
      state.reassignFilters.type === "all" || item.type === state.reassignFilters.type;
    return matchesText && matchesRequester && matchesType;
  });
  filtered = sortMediaEntries(filtered, state.reassignFilters.sort);
  state.reassignVisibleItems = filtered;
  byId("reassign-count").textContent = `${filtered.length} of ${items.length} titles`;
  updateBulkSelectionSummary();
  list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "list-empty";
    empty.textContent = "No media matches these filters.";
    list.append(empty);
    return;
  }
  filtered.forEach((item) => list.append(makeAssignmentRow(item, profiles)));
}

function makeDeleteRow(item, profiles) {
  const row = document.createElement("article");
  row.className = "media-row delete-media-row";
  const checkboxTarget = document.createElement("label");
  checkboxTarget.className = "media-select-target";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "media-select-checkbox delete-media-select-checkbox";
  checkbox.checked = state.selectedDeleteMedia.has(item.key);
  checkbox.setAttribute("aria-label", `Select ${item.title} for deletion from Quotarr`);
  checkboxTarget.append(checkbox);
  row.classList.toggle("selected", checkbox.checked);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.selectedDeleteMedia.add(item.key);
    else state.selectedDeleteMedia.delete(item.key);
    state.deleteConfirm = false;
    row.classList.toggle("selected", checkbox.checked);
    updateDeleteSelectionSummary();
  });
  const primary = document.createElement("div");
  primary.className = "entry-primary";
  primary.addEventListener("click", () => checkbox.click());
  primary.append(makeThumb(item.poster));
  const title = document.createElement("div");
  title.className = "entry-title";
  const name = document.createElement("strong");
  name.textContent = item.title;
  const requester = profiles.find((profile) => profile.id === item.requesterProfileId);
  const meta = document.createElement("span");
  meta.textContent = `${formatBytes(item.size)} · ${item.type} · ${requester?.name || "No Seerr request"} · ${item.dateRequested ? formatDate(item.dateRequested) : "No request date"}`;
  title.append(name, meta);
  primary.append(title);
  row.append(checkboxTarget, primary);
  return row;
}

function updateDeleteSelectionSummary() {
  const visibleItems = state.deleteVisibleItems;
  const selectedVisible = visibleItems.reduce(
    (count, item) => count + Number(state.selectedDeleteMedia.has(item.key)),
    0,
  );
  const selectAll = byId("delete-select-filtered");
  selectAll.checked = visibleItems.length > 0 && selectedVisible === visibleItems.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleItems.length;
  selectAll.disabled = visibleItems.length === 0;
  byId("delete-selected-count").textContent = `${state.selectedDeleteMedia.size} selected`;
  byId("delete-selected-button").disabled = state.selectedDeleteMedia.size === 0;
  byId("delete-clear-selection").disabled = state.selectedDeleteMedia.size === 0;
  byId("delete-selected-button").textContent = state.deleteConfirm
    ? "Are you sure?"
    : "Delete selected";
  byId("delete-selected-button").classList.toggle("button-danger-confirm", state.deleteConfirm);
}

function renderDeleteList() {
  const list = byId("delete-list");
  if (!list || !state.dashboard) return;
  const { profiles, items } = state.dashboard;
  const availableKeys = new Set(items.map((item) => item.key));
  state.selectedDeleteMedia = new Set(
    [...state.selectedDeleteMedia].filter((key) => availableKeys.has(key)),
  );
  const requesterSelect = byId("delete-requester");
  const selectedRequester = state.deleteFilters.requester;
  requesterSelect.replaceChildren();
  [
    ["all", "Everyone"],
    ["none", "No Seerr request"],
  ].forEach(([value, text]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    requesterSelect.append(option);
  });
  profiles
    .filter((profile) => profile.id !== "default")
    .forEach((profile) => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.name;
      requesterSelect.append(option);
    });
  requesterSelect.value = [...requesterSelect.options].some(
    (option) => option.value === selectedRequester,
  )
    ? selectedRequester
    : "all";
  byId("delete-search").value = state.deleteFilters.query;
  byId("delete-type").value = state.deleteFilters.type;
  byId("delete-sort").value = state.deleteFilters.sort;

  let filtered = items.filter((item) => {
    const matchesText = item.title
      .toLowerCase()
      .includes(state.deleteFilters.query.trim().toLowerCase());
    const matchesRequester =
      state.deleteFilters.requester === "all" ||
      (state.deleteFilters.requester === "none"
        ? !item.requesterProfileId
        : item.requesterProfileId === state.deleteFilters.requester);
    const matchesType =
      state.deleteFilters.type === "all" || item.type === state.deleteFilters.type;
    return matchesText && matchesRequester && matchesType;
  });
  filtered = sortMediaEntries(filtered, state.deleteFilters.sort);
  state.deleteVisibleItems = filtered;
  byId("delete-count").textContent = `${filtered.length} of ${items.length} titles`;
  updateDeleteSelectionSummary();
  list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "list-empty";
    empty.textContent = "No media matches these filters.";
    list.append(empty);
  } else {
    filtered.forEach((item) => list.append(makeDeleteRow(item, profiles)));
  }

  const deletedList = byId("deleted-media-list");
  const deletedItems = state.deletedItems;
  byId("deleted-media-count").textContent =
    `${deletedItems.length} ${deletedItems.length === 1 ? "title" : "titles"}`;
  deletedList.replaceChildren();
  if (!deletedItems.length) {
    const empty = document.createElement("p");
    empty.className = "list-empty";
    empty.textContent = "No deleted media.";
    deletedList.append(empty);
  } else {
    deletedItems.forEach((item) => {
      const row = document.createElement("article");
      row.className = "media-row deleted-media-row";
      const primary = document.createElement("div");
      primary.className = "entry-primary";
      primary.append(makeThumb(item.poster));
      const title = document.createElement("div");
      title.className = "entry-title";
      const name = document.createElement("strong");
      name.textContent = item.title;
      const meta = document.createElement("span");
      const serviceName = item.type === "Movie" ? "Radarr" : "Sonarr";
      const externalStatus =
        item.externalRemovalStatus === "removed"
          ? `Removed from ${serviceName}${item.deleteFiles ? " · Files deleted" : " · Files left on disk"}`
          : item.externalRemovalStatus === "failed"
            ? `Removal from ${serviceName} failed or is uncertain`
            : item.externalRemovalStatus === "pending"
              ? `Removal from ${serviceName} may be incomplete`
              : "Quotarr only";
      meta.textContent = `${item.type} · ${externalStatus} · Hidden ${formatDate(item.deletedAt)}`;
      title.append(name, meta);
      primary.append(title);
      const restoreButton = document.createElement("button");
      restoreButton.className = "button button-secondary";
      restoreButton.type = "button";
      restoreButton.textContent = "Restore in Quotarr";
      restoreButton.addEventListener("click", () => restoreDeletedMedia(item.key, restoreButton));
      row.append(primary, restoreButton);
      deletedList.append(row);
    });
  }
}

async function assignItem(key, profileId, select) {
  select.disabled = true;
  try {
    await api("/api/assign", { method: "POST", body: JSON.stringify({ key, profileId }) });
    await refreshDashboard(false);
  } catch (error) {
    showNotice(byId("settings-notice"), error.message);
  } finally {
    select.disabled = false;
  }
}

async function assignSelectedItems() {
  const keys = [...state.selectedMedia];
  const profileId = byId("bulk-profile").value;
  const button = byId("bulk-assign-button");
  if (!keys.length || !profileId) return;
  button.disabled = true;
  showNotice(byId("settings-notice"), "");
  try {
    const result = await api("/api/assign-bulk", {
      method: "POST",
      body: JSON.stringify({ keys, profileId }),
    });
    state.selectedMedia.clear();
    await refreshDashboard(false);
    showNotice(byId("settings-notice"), `${result.assigned} media items reassigned.`, "success");
  } catch (error) {
    showNotice(byId("settings-notice"), error.message);
  } finally {
    updateBulkSelectionSummary();
  }
}

async function deleteSelectedItems() {
  const keys = [...state.selectedDeleteMedia];
  if (!keys.length) return;
  if (!state.deleteConfirm) {
    state.deleteConfirm = true;
    updateDeleteSelectionSummary();
    return;
  }
  const button = byId("delete-selected-button");
  button.disabled = true;
  showNotice(byId("settings-notice"), "");
  const deleteFromArr = byId("delete-from-arr").checked;
  const deleteFiles = byId("delete-files").checked;
  try {
    const result = await api("/api/delete-bulk", {
      method: "POST",
      body: JSON.stringify({ keys, confirmed: true, deleteFromArr, deleteFiles }),
    });
    state.selectedDeleteMedia.clear();
    state.deleteConfirm = false;
    await refreshDashboard(false);
    const message = result.failed.length
      ? `${result.deleted} media items hidden in Quotarr. Some could not be removed from Radarr/Sonarr: ${result.failed.map((item) => `${item.title}: ${item.message}`).join("; ")}`
      : `${result.deleted} media items hidden in Quotarr${deleteFromArr ? ` and removed from Radarr/Sonarr${deleteFiles ? " with files deleted" : " with files left on disk"}` : ""}.`;
    showNotice(byId("settings-notice"), message, result.failed.length ? "error" : "success");
  } catch (error) {
    state.deleteConfirm = false;
    showNotice(byId("settings-notice"), error.message);
  } finally {
    updateDeleteSelectionSummary();
    byId("delete-from-arr").checked = false;
    byId("delete-files").checked = false;
    byId("delete-files").disabled = true;
  }
}

async function restoreDeletedMedia(key, button) {
  const wasRemovedFromArr = state.deletedItems.some(
    (item) => item.key === key && ["removed", "pending"].includes(item.externalRemovalStatus),
  );
  button.disabled = true;
  showNotice(byId("settings-notice"), "");
  try {
    await api("/api/restore-media", { method: "POST", body: JSON.stringify({ key }) });
    await refreshDashboard(false);
    showNotice(
      byId("settings-notice"),
      wasRemovedFromArr
        ? "Visibility restored in Quotarr only. The title was not re-added to Radarr/Sonarr and deleted files cannot be recovered here."
        : "Media restored to Quotarr.",
      "success",
    );
  } catch (error) {
    showNotice(byId("settings-notice"), error.message);
  } finally {
    button.disabled = false;
  }
}

function showHoverCard(item, pointerEvent) {
  const card = byId("hover-card");
  card.replaceChildren();
  state.hoverCardKey = item.key;
  const image = makeThumb(item.poster, "hover-image");
  const content = document.createElement("div");
  content.className = "hover-content";
  const title = document.createElement("h3");
  title.textContent = item.title;
  const type = document.createElement("p");
  type.className = "hover-type";
  type.textContent = item.type;
  const facts = document.createElement("dl");
  [
    ["Requested", formatDate(item.dateRequested)],
    ["Size", item.inLibrary === false ? "Not downloaded" : formatBytes(item.size)],
    ["Released", formatDate(item.dateReleased)],
  ].forEach(([label, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    row.append(term, description);
    facts.append(row);
  });
  content.append(title, type, facts);
  card.append(image, content);
  card.hidden = false;
  card.setAttribute("aria-hidden", "false");
  positionHoverCard(pointerEvent);
}

function hideHoverCard() {
  const card = byId("hover-card");
  card.hidden = true;
  card.setAttribute("aria-hidden", "true");
  state.hoverCardKey = null;
}

function positionHoverCard(pointerEvent) {
  const card = byId("hover-card");
  if (card.hidden) return;
  const gap = 16;
  const bounds = card.getBoundingClientRect();
  const left =
    pointerEvent.clientX + bounds.width + gap > window.innerWidth
      ? pointerEvent.clientX - bounds.width - gap
      : pointerEvent.clientX + gap;
  const top =
    pointerEvent.clientY + bounds.height + gap > window.innerHeight
      ? Math.max(8, pointerEvent.clientY - bounds.height - gap)
      : pointerEvent.clientY + gap;
  card.style.left = `${Math.max(8, left)}px`;
  card.style.top = `${Math.max(8, top)}px`;
}

document.addEventListener("pointerover", (event) => {
  if (event.pointerType === "touch") return;
  const entry = event.target.closest?.(".bar-scroll [data-hover-key]");
  if (!entry || entry.contains(event.relatedTarget)) return;
  const item = state.hoverDetails.get(entry.dataset.hoverKey);
  if (item) showHoverCard(item, event);
});
document.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch") {
    const start = state.touchHoverStart;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
      state.touchHoverStart = null;
    }
    return;
  }
  positionHoverCard(event);
});
document.addEventListener("pointerout", (event) => {
  if (event.pointerType === "touch") return;
  const entry = event.target.closest?.(".bar-scroll [data-hover-key]");
  if (entry && !entry.contains(event.relatedTarget)) {
    hideHoverCard();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "touch") return;
  const card = byId("hover-card");
  if (card.contains(event.target)) return;
  const entry = event.target.closest?.(".bar-scroll [data-hover-key]");
  const item = entry && state.hoverDetails.get(entry.dataset.hoverKey);
  state.touchHoverStart = item
    ? {
        key: entry.dataset.hoverKey,
        wasOpen: state.hoverCardKey === item.key,
        x: event.clientX,
        y: event.clientY,
      }
    : null;
  hideHoverCard();
});
document.addEventListener("pointerup", (event) => {
  if (event.pointerType !== "touch") return;
  const start = state.touchHoverStart;
  state.touchHoverStart = null;
  if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10 || start.wasOpen)
    return;
  const item = state.hoverDetails.get(start.key);
  if (item) showHoverCard(item, event);
});
document.addEventListener("pointercancel", (event) => {
  if (event.pointerType === "touch") state.touchHoverStart = null;
});

function profileOrderFromCards() {
  return [...byId("profiles").querySelectorAll(".profile-card")]
    .map((card) => card.dataset.profileId)
    .filter((id) => id && id !== "default");
}

function orderCards(order) {
  const container = byId("profiles");
  const cards = new Map(
    [...container.querySelectorAll(".profile-card")].map((card) => [card.dataset.profileId, card]),
  );
  const uniqueOrder = [...new Set(order)];
  const ownId = String(state.user?.id);
  if (uniqueOrder.includes(ownId)) {
    uniqueOrder.splice(uniqueOrder.indexOf(ownId), 1);
    uniqueOrder.unshift(ownId);
  }
  const orderedIds = [
    ...uniqueOrder,
    ...[...cards.keys()].filter((id) => id !== "default" && !uniqueOrder.includes(id)),
  ];
  orderedIds.forEach((id) => {
    const card = cards.get(id);
    if (card) container.append(card);
  });
  if (cards.has("default")) container.append(cards.get("default"));
  return orderedIds;
}

async function saveProfileOrderFromCards() {
  const order = orderCards(profileOrderFromCards());
  if (state.user?.isAdmin) {
    try {
      await api("/api/profile-order", {
        method: "POST",
        body: JSON.stringify({ order }),
      });
    } catch (error) {
      showNotice(byId("notice"), `Could not save the global profile order. ${error.message}`);
      renderDashboard(state.dashboard);
    }
    return;
  }
  state.localProfileOrder = order;
  try {
    localStorage.setItem(`storage-tally-profile-order:${state.user.id}`, JSON.stringify(order));
  } catch (error) {
    showNotice(byId("notice"), `Could not save this browser's profile order: ${error.message}`);
  }
}

function moveDraggedProfile(target, clientY) {
  if (!state.draggedProfileId || !target || target.dataset.profileId === "default") return false;
  const dragged = [...byId("profiles").querySelectorAll(".profile-card")].find(
    (card) => card.dataset.profileId === state.draggedProfileId,
  );
  if (!dragged || dragged === target) return false;
  const bounds = target.getBoundingClientRect();
  const before = clientY < bounds.top + bounds.height / 2 ? target : target.nextElementSibling;
  if (before === dragged || dragged.nextElementSibling === before) return false;
  byId("profiles").insertBefore(dragged, before);
  return true;
}

async function finishProfileDrag(card) {
  const draggedId = state.draggedProfileId;
  const draggedCard = [...byId("profiles").querySelectorAll(".profile-card")].find(
    (profileCard) => profileCard.dataset.profileId === draggedId,
  );
  (draggedCard || card)?.classList.remove("dragging");
  const changed =
    draggedId && state.dragInitialOrder.join("\0") !== profileOrderFromCards().join("\0");
  state.draggedProfileId = null;
  state.dragInitialOrder = [];
  state.touchDragPointerId = null;
  if (changed) await saveProfileOrderFromCards();
}

byId("profiles").addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "touch" || state.draggedProfileId) return;
  const handle = event.target.closest?.(".profile-drag-handle");
  const card = handle?.closest(".profile-card");
  if (!handle || !card || card.dataset.profileId === "default") return;
  event.preventDefault();
  state.draggedProfileId = card.dataset.profileId;
  state.dragInitialOrder = profileOrderFromCards();
  state.touchDragPointerId = event.pointerId;
  card.classList.add("dragging");
  handle.setPointerCapture(event.pointerId);
});
byId("profiles").addEventListener("pointermove", (event) => {
  if (event.pointerId !== state.touchDragPointerId) return;
  event.preventDefault();
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".profile-card");
  moveDraggedProfile(target, event.clientY);
});
byId("profiles").addEventListener("pointerup", async (event) => {
  if (event.pointerId === state.touchDragPointerId) {
    await finishProfileDrag(event.target.closest?.(".profile-card"));
  }
});
byId("profiles").addEventListener("pointercancel", async (event) => {
  if (event.pointerId === state.touchDragPointerId) {
    await finishProfileDrag(event.target.closest?.(".profile-card"));
  }
});
byId("profiles").addEventListener("dragstart", (event) => {
  const handle = event.target.closest?.(".profile-drag-handle");
  const card = handle?.closest(".profile-card");
  if (!card) return;
  state.draggedProfileId = card.dataset.profileId;
  state.dragInitialOrder = profileOrderFromCards();
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.draggedProfileId);
});
byId("profiles").addEventListener("dragover", (event) => {
  if (!state.draggedProfileId) return;
  const target = event.target.closest?.(".profile-card");
  if (!target || target.dataset.profileId === "default") return;
  event.preventDefault();
  moveDraggedProfile(target, event.clientY);
});
byId("profiles").addEventListener("drop", (event) => {
  if (state.draggedProfileId) event.preventDefault();
});
byId("profiles").addEventListener("dragend", async (event) => {
  await finishProfileDrag(event.target.closest?.(".profile-card"));
});

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", async () => {
    setView(tab.dataset.view);
    if (tab.dataset.view === "settings") {
      setSettingsSection("connections");
      try {
        await loadSettings();
        await refreshDashboard(false);
      } catch (error) {
        showNotice(byId("settings-notice"), error.message);
      }
    } else {
      await refreshDashboard(false);
    }
  }),
);

function setSettingsSection(section) {
  byId("settings-connections").hidden = section !== "connections";
  byId("settings-notifications").hidden = section !== "notifications";
  byId("settings-reassign").hidden = section !== "reassign";
  byId("settings-delete").hidden = section !== "delete";
  byId("settings-updates").hidden = section !== "updates";
  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.settingsSection === section);
  });
  if (section === "reassign") renderReassignList();
  if (section === "delete") renderDeleteList();
}

document
  .querySelectorAll(".settings-tab")
  .forEach((tab) =>
    tab.addEventListener("click", () => setSettingsSection(tab.dataset.settingsSection)),
  );
byId("reassign-search").addEventListener("input", () => {
  state.reassignFilters.query = byId("reassign-search").value;
  renderReassignList();
});
byId("reassign-requester").addEventListener("change", () => {
  state.reassignFilters.requester = byId("reassign-requester").value;
  renderReassignList();
});
byId("reassign-type").addEventListener("change", () => {
  state.reassignFilters.type = byId("reassign-type").value;
  renderReassignList();
});
byId("reassign-sort").addEventListener("change", () => {
  state.reassignFilters.sort = byId("reassign-sort").value;
  renderReassignList();
});
byId("delete-search").addEventListener("input", () => {
  state.deleteFilters.query = byId("delete-search").value;
  state.deleteConfirm = false;
  renderDeleteList();
});
byId("delete-requester").addEventListener("change", () => {
  state.deleteFilters.requester = byId("delete-requester").value;
  state.deleteConfirm = false;
  renderDeleteList();
});
byId("delete-type").addEventListener("change", () => {
  state.deleteFilters.type = byId("delete-type").value;
  state.deleteConfirm = false;
  renderDeleteList();
});
byId("delete-sort").addEventListener("change", () => {
  state.deleteFilters.sort = byId("delete-sort").value;
  state.deleteConfirm = false;
  renderDeleteList();
});
byId("delete-from-arr").addEventListener("change", () => {
  const removeFromArr = byId("delete-from-arr").checked;
  byId("delete-files").disabled = !removeFromArr;
  if (!removeFromArr) byId("delete-files").checked = false;
  state.deleteConfirm = false;
  updateDeleteSelectionSummary();
});
byId("delete-files").addEventListener("change", () => {
  state.deleteConfirm = false;
  updateDeleteSelectionSummary();
});
byId("select-filtered").addEventListener("change", () => {
  const checked = byId("select-filtered").checked;
  state.reassignVisibleItems.forEach((item) => {
    if (checked) state.selectedMedia.add(item.key);
    else state.selectedMedia.delete(item.key);
  });
  document.querySelectorAll("#reassign-list .media-select-checkbox").forEach((checkbox) => {
    checkbox.checked = checked;
    checkbox.closest(".media-row").classList.toggle("selected", checked);
  });
  updateBulkSelectionSummary();
});
byId("bulk-profile").addEventListener("change", updateBulkSelectionSummary);
byId("clear-selection").addEventListener("click", () => {
  state.selectedMedia.clear();
  document.querySelectorAll("#reassign-list .media-select-checkbox").forEach((checkbox) => {
    checkbox.checked = false;
    checkbox.closest(".media-row").classList.remove("selected");
  });
  updateBulkSelectionSummary();
});
byId("bulk-assign-button").addEventListener("click", assignSelectedItems);
byId("delete-select-filtered").addEventListener("change", () => {
  const checked = byId("delete-select-filtered").checked;
  state.deleteVisibleItems.forEach((item) => {
    if (checked) state.selectedDeleteMedia.add(item.key);
    else state.selectedDeleteMedia.delete(item.key);
  });
  state.deleteConfirm = false;
  document.querySelectorAll("#delete-list .delete-media-select-checkbox").forEach((checkbox) => {
    checkbox.checked = checked;
    checkbox.closest(".media-row").classList.toggle("selected", checked);
  });
  updateDeleteSelectionSummary();
});
byId("delete-selected-button").addEventListener("click", deleteSelectedItems);
byId("delete-clear-selection").addEventListener("click", () => {
  state.selectedDeleteMedia.clear();
  state.deleteConfirm = false;
  byId("delete-from-arr").checked = false;
  byId("delete-files").checked = false;
  byId("delete-files").disabled = true;
  document.querySelectorAll("#delete-list .delete-media-select-checkbox").forEach((checkbox) => {
    checkbox.checked = false;
    checkbox.closest(".media-row").classList.remove("selected");
  });
  updateDeleteSelectionSummary();
});
byId("refresh-button").addEventListener("click", () => refreshDashboard(true));
byId("check-updates").addEventListener("click", async () => {
  const button = byId("check-updates");
  button.disabled = true;
  button.textContent = "Checking GitHub...";
  showNotice(byId("update-notice"), "");
  try {
    renderUpdateInfo(await api("/api/update"));
  } catch (error) {
    showNotice(byId("update-notice"), error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Check for updates";
  }
});
byId("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  saveSettings(false);
});
byId("sync-settings").addEventListener("click", () => saveSettings(true));
byId("save-notifications").addEventListener("click", () => saveSettings(false));
byId("notification-enabled").addEventListener("change", updateNotificationSettingsEnabled);
byId("add-notification-service").addEventListener("click", () => {
  const menu = byId("notification-service-menu");
  menu.hidden = !menu.hidden;
  byId("add-notification-service").setAttribute("aria-expanded", String(!menu.hidden));
});
byId("notification-service-menu").addEventListener("click", (event) => {
  const providerId = event.target.closest("[data-add-notification-provider]")?.dataset.addNotificationProvider;
  if (!providerId) return;
  addNotificationProvider(providerId);
  byId("notification-service-menu").hidden = true;
  byId("add-notification-service").setAttribute("aria-expanded", "false");
});
byId("notification-providers").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  const card = button?.closest(".notification-card");
  if (button?.hasAttribute("data-remove-notification")) {
    card.remove();
    updateNotificationProviderTitles();
    await saveSettings(false);
    return;
  }
  const action = button?.dataset.webPushAction;
  const instanceId = button?.dataset.instanceId;
  const testProvider = button?.dataset.testProvider;
  try {
    if (action === "subscribe") await subscribeBrowserForPush(instanceId);
    else if (action === "unsubscribe") await unsubscribeBrowserFromPush(instanceId);
    else if (testProvider) await testNotificationProvider(testProvider, instanceId);
  } catch (error) {
    showNotice(byId("settings-notice"), error.message);
  }
});
byId("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = byId("login-button");
  button.disabled = true;
  showNotice(byId("login-notice"), "");
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: byId("login-username").value.trim(),
        password: byId("login-password").value,
      }),
    });
    byId("login-password").value = "";
    await enterApp(result.user);
  } catch (error) {
    showNotice(byId("login-notice"), error.message);
  } finally {
    button.disabled = false;
  }
});
byId("logout-button").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } finally {
    showLogin();
  }
});

async function initialize() {
  try {
    const session = await api("/api/session");
    if (session.authenticated) await enterApp(session.user);
    else showLogin();
  } catch (error) {
    showLogin(error.message);
  }
}

initialize();
