// The agent for recorded clips: chats, runs and routines over the demo
// profiles, and pictures of the pages it works on. Loaded after demo-data.js
// when a clip sets `agentPlan`. `window.__agentDemo.play()` starts the live
// part (steps, a run moving on) on the page's clock, so it plays at the
// take's pace. Every name, page and number here is invented.
(() => {
  const options = window.__CLIP_DEMO__ || {};
  if (!options.agentPlan) return;
  const data = window.__CLIP_DATA__;
  const handlers = window.__HANDLERS__;
  const user = data.user;
  if (user) {
    user.entitlements.agent = true;
    user.entitlements.scheduledAutomation = true;
  }
  const id = (name) =>
    data.profiles.find((profile) => profile.name === name)?.id;
  const nowMs = Date.now();
  const MIN = 60_000;
  const emit = (event, payload) => window.__clipEmit?.(event, payload);

  // Pages the agent looks at, drawn as SVG.
  const ink = "#1f2430";
  const soft = "#8a93a6";
  const line = (x, y, w, color = "#e4e7ee", h = 8) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${color}"/>`;
  const text = (x, y, value, size = 13, color = ink, weight = 500) =>
    `<text x="${x}" y="${y}" font-family="-apple-system,Segoe UI,Helvetica,Arial" font-size="${size}" font-weight="${weight}" fill="${color}">${value}</text>`;
  const frame = (host, body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#ffffff"/><rect width="640" height="34" fill="#f3f4f7"/>${line(14, 13, 8, "#ff5f57", 8)}${line(28, 13, 8, "#febc2e", 8)}${line(42, 13, 8, "#28c840", 8)}<rect x="120" y="8" width="400" height="18" rx="9" fill="#ffffff"/>${text(136, 21, host, 10, soft, 400)}${body}</svg>`;
  const PAGES = {
    ipinfo: frame(
      "ipinfo.io/json",
      [
        ["ip", "192.0.2.204"],
        ["city", "Toronto"],
        ["region", "Ontario"],
        ["country", "CA"],
        ["org", "AS64500 Residential ISP"],
        ["timezone", "America/Toronto"],
      ]
        .map(
          ([key, value], index) =>
            text(40, 80 + index * 28, `"${key}":`, 15, "#a1408a", 500) +
            text(150, 80 + index * 28, `"${value}",`, 15, "#2a7a3f", 500),
        )
        .join("") + text(24, 60, "{", 15, ink, 500),
    ),
    shop: frame(
      "shop.example.com/orders",
      `${text(32, 70, "Orders", 20, ink, 700)}${[0, 1, 2, 3, 4]
        .map(
          (row) =>
            `<rect x="32" y="${92 + row * 56}" width="576" height="46" rx="10" fill="#f6f7fa"/>${text(48, 120 + row * 56, `#10${42 + row}`, 13, ink, 600)}${line(120, 112 + row * 56, 180)}${text(500, 120 + row * 56, row === 1 ? "Needs address" : "Shipped", 12, row === 1 ? "#b7791f" : "#2f855a", 600)}`,
        )
        .join("")}`,
    ),
    social: frame(
      "social.example.net/notifications",
      `${text(32, 70, "Comments", 20, ink, 700)}${[0, 1, 2]
        .map(
          (row) =>
            `<circle cx="52" cy="${112 + row * 88}" r="16" fill="#dfe6f6"/>${line(80, 100 + row * 88, 140, "#c9d1e3")}${line(80, 118 + row * 88, 420)}${line(80, 134 + row * 88, 300)}`,
        )
        .join("")}`,
    ),
    news: frame(
      "news.example.org",
      `${text(32, 74, "Morning briefing", 22, ink, 700)}<rect x="32" y="94" width="360" height="170" rx="12" fill="#e9edf5"/>${[
        0, 1, 2, 3, 4, 5,
      ]
        .map((row) => line(412, 100 + row * 26, 196 - (row % 3) * 30))
        .join(
          "",
        )}${[0, 1, 2].map((row) => line(32, 288 + row * 24, 540 - row * 90)).join("")}`,
    ),
    prices: frame(
      "store.example.com/search?q=headphones",
      `${text(32, 70, "Headphones", 20, ink, 700)}${[0, 1, 2]
        .map(
          (col) =>
            `<rect x="${32 + col * 196}" y="92" width="180" height="120" rx="12" fill="#eef1f6"/>${line(32 + col * 196, 226, 140)}${text(32 + col * 196, 262, ["€89", "€104", "€131"][col], 16, ink, 700)}`,
        )
        .join("")}`,
    ),
  };
  const shot = (page) => ({
    image: `data:image/svg+xml;utf8,${encodeURIComponent(PAGES[page])}`,
    host: {
      ipinfo: "ipinfo.io",
      shop: "shop.example.com",
      social: "social.example.net",
      news: "news.example.org",
      prices: "store.example.com",
    }[page],
  });
  const pageOf = new Map();

  const step = (index, kind, value, url, at) => ({
    index,
    kind,
    text: value,
    ...(url ? { url } : {}),
    at,
  });
  const turn = (profileId, prompt, status, steps, result, extra = {}) => ({
    id: `turn-${profileId}-${prompt.length}`,
    text: prompt,
    kind: "start",
    steers: [],
    hostCalls: [],
    profileId,
    taskId: `task-${profileId}`,
    status,
    steps,
    approval: null,
    result,
    error: null,
    creditsUsed: steps.length * 7,
    startedAt: nowMs - 9 * MIN,
    finishedAt: status === "done" ? nowMs - 6 * MIN : null,
    ...extra,
  });

  const MATCH =
    "| IP | Country | IP time zone | Browser time zone | Language | Match |\n|---|---|---|---|---|---|\n| 192.0.2.204 | CA | America/Toronto | America/Toronto | en-CA | yes |";
  const chats = [
    {
      id: "chat-orders",
      title: "Check today's orders",
      profileId: id("Shop · US"),
      createdAt: nowMs - 50 * MIN,
      updatedAt: nowMs - 40 * MIN,
      turns: [
        turn(
          id("Shop · US"),
          "Check today's orders and tell me which ones need attention.",
          "done",
          [
            step(
              0,
              "act",
              "Opening the orders page",
              "https://shop.example.com/orders",
              nowMs - 45 * MIN,
            ),
            step(
              1,
              "observe",
              "Five orders today; one has no shipping address",
              null,
              nowMs - 44 * MIN,
            ),
          ],
          "**5 orders** today. Order #1043 needs a shipping address; the rest are shipped.",
          { finishedAt: nowMs - 40 * MIN },
        ),
      ],
    },
    {
      id: "chat-match",
      title: "Proxy and fingerprint match",
      profileId: id("Ads 01"),
      createdAt: nowMs - 30 * MIN,
      updatedAt: nowMs - 25 * MIN,
      turns: [
        turn(
          id("Ads 01"),
          "Open https://ipinfo.io/json in this profile and compare it with the browser's time zone and languages.",
          "done",
          [
            step(
              0,
              "act",
              "Opening ipinfo.io/json",
              "https://ipinfo.io/json",
              nowMs - 29 * MIN,
            ),
            step(
              1,
              "observe",
              "The exit is in Toronto, America/Toronto",
              null,
              nowMs - 28 * MIN,
            ),
          ],
          MATCH,
          { finishedAt: nowMs - 25 * MIN },
        ),
      ],
    },
    {
      id: "chat-comments",
      title: "Reply to new comments",
      profileId: id("Social · Main"),
      createdAt: nowMs - 4 * MIN,
      updatedAt: nowMs - MIN,
      turns: [
        turn(
          id("Social · Main"),
          "Read the new comments on yesterday's post and like the friendly ones. Ask me before you reply to anyone.",
          "running",
          [
            step(
              0,
              "think",
              "Planning: notifications first, then the post",
              null,
              nowMs - 3 * MIN,
            ),
            step(
              1,
              "act",
              "Opening the notifications",
              "https://social.example.net/notifications",
              nowMs - 2 * MIN,
            ),
          ],
          null,
          { startedAt: nowMs - 3 * MIN },
        ),
      ],
    },
  ];
  pageOf.set(id("Social · Main"), "social");
  pageOf.set(id("Shop · US"), "shop");
  pageOf.set(id("Ads 01"), "ipinfo");

  const task = (name, status, extra = {}) => ({
    profileId: id(name),
    taskId: `task-run-${id(name)}`,
    runId: null,
    status,
    lastStep: null,
    stepCount: 0,
    approval: null,
    result: null,
    error: null,
    creditsUsed: 0,
    startedAt: status === "queued" ? null : nowMs - 5 * MIN,
    finishedAt: null,
    ...extra,
  });
  const runNames = [
    "Shop · UK",
    "Ads 02",
    "Social · Brand",
    "Forum",
    "Market research",
    "Price watch",
    "Travel deals",
    "Throwaway",
  ];
  const batch = {
    id: "run-warmup",
    routineId: null,
    prompt:
      "Browse the news for a few minutes, read two articles, and note anything about our brand.",
    startUrl: "https://news.example.org",
    autonomy: "ask",
    maxCredits: null,
    headless: false,
    concurrency: 4,
    createdAt: nowMs - 6 * MIN,
    stopping: false,
    finished: false,
    tasks: [],
    tally: {},
  };
  const READING = [
    "Opening the news site",
    "Reading the top story",
    "Scrolling the business section",
    "Reading an article on retail",
    "Noting two mentions of the brand",
  ];
  const RESULTS = [
    "Two articles read; no brand mentions",
    "Read three stories; one brand mention in retail news",
    "Two articles read; nothing about the brand",
  ];
  let readingIndex = 0;
  const reading = (_name, n) => ({
    lastStep: step(
      n,
      "act",
      READING[n % READING.length],
      "https://news.example.org",
      nowMs,
    ),
    stepCount: n + 1,
    creditsUsed: (n + 1) * 7,
  });
  batch.tasks = [
    task("Shop · UK", "done", {
      result: RESULTS[0],
      finishedAt: nowMs - 2 * MIN,
      stepCount: 6,
      creditsUsed: 42,
    }),
    task("Ads 02", "running", reading("Ads 02", 3)),
    task("Social · Brand", "running", reading("Social · Brand", 1)),
    task("Forum", "needs_approval", {
      ...reading("Forum", 2),
      approval: {
        approvalId: "ap-1",
        question: "The site asks to accept cookies. Accept them?",
      },
    }),
    task("Market research", "running", reading("Market research", 0)),
    task("Price watch", "queued"),
    task("Travel deals", "queued"),
    task("Throwaway", "queued"),
  ];
  for (const name of runNames) pageOf.set(id(name), "news");
  pageOf.set(id("Price watch"), "prices");
  const tallyOf = (tasks) => {
    const tally = {
      queued: 0,
      active: 0,
      done: 0,
      failed: 0,
      stopped: 0,
      creditsUsed: 0,
    };
    for (const item of tasks) {
      tally.creditsUsed += item.creditsUsed;
      if (item.status === "queued") tally.queued += 1;
      else if (item.status === "done") tally.done += 1;
      else if (item.status === "failed") tally.failed += 1;
      else if (item.status === "stopped") tally.stopped += 1;
      else tally.active += 1;
    }
    return tally;
  };
  batch.tally = tallyOf(batch.tasks);

  const day = (offset, hour) => {
    const date = new Date(nowMs);
    date.setDate(date.getDate() - offset);
    date.setHours(hour, 0, 0, 0);
    return date;
  };
  const routines = [
    {
      id: "routine-daily",
      name: "Daily account check",
      prompt:
        "Sign in check: open the account page, confirm it is signed in, and report any notice or warning.",
      startUrl: "https://shop.example.com/account",
      profileIds: [
        id("Shop · US"),
        id("Shop · UK"),
        id("Ads 01"),
        id("Social · Main"),
      ],
      schedule: {
        cron: "0 9 * * *",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      maxCreditsPerRun: 200,
      concurrency: 2,
      enabled: true,
      nextRunAt: new Date(day(-1, 9)).toISOString(),
      createdAt: day(9, 9).toISOString(),
      updatedAt: day(9, 9).toISOString(),
    },
    {
      id: "routine-match",
      name: "Proxy and fingerprint match",
      prompt: chats[1].turns[0].text,
      startUrl: null,
      profileIds: [id("Ads 01"), id("Ads 02")],
      schedule: null,
      maxCreditsPerRun: null,
      concurrency: null,
      enabled: true,
      nextRunAt: null,
      createdAt: day(3, 14).toISOString(),
      updatedAt: day(3, 14).toISOString(),
    },
    {
      id: "routine-prices",
      name: "Weekly price report",
      prompt:
        "Search the store for headphones and list the three lowest prices.",
      startUrl: "https://store.example.com",
      profileIds: [id("Price watch"), id("Market research")],
      schedule: {
        cron: "0 8 * * 1",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      maxCreditsPerRun: null,
      concurrency: null,
      enabled: true,
      nextRunAt: new Date(day(-3, 8)).toISOString(),
      createdAt: day(20, 8).toISOString(),
      updatedAt: day(20, 8).toISOString(),
    },
  ];
  const SUMMARIES = {
    "Shop · US": "Signed in. No notices.",
    "Shop · UK": "Signed in. A new policy notice about returns.",
    "Ads 01": "Signed in. Billing method expires next month.",
    "Social · Main": "Signed in. No notices.",
  };
  const routineRuns = [0, 1, 2, 3].flatMap((offset) =>
    routines[0].profileIds.map((profileId) => {
      const name = data.profiles.find((p) => p.id === profileId).name;
      const failed = offset === 2 && name === "Social · Main";
      return {
        runId: `rr-${offset}-${profileId}`,
        batchId: `rb-${offset}`,
        profileId,
        status: failed ? "failed" : "done",
        summary: failed ? null : SUMMARIES[name],
        creditsUsed: 18 + ((offset * 7 + name.length) % 11),
        error: failed ? "The page did not load" : null,
        createdAt: day(offset, 9).toISOString(),
        finishedAt: new Date(day(offset, 9).getTime() + 3 * MIN).toISOString(),
      };
    }),
  );

  const summary = (chat) => ({
    id: chat.id,
    title: chat.title,
    profileId: chat.profileId,
    profileName:
      data.profiles.find((p) => p.id === chat.profileId)?.name ?? null,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    status: chat.turns.at(-1)?.status ?? null,
    turns: chat.turns.length,
  });
  const copy = (value) => JSON.parse(JSON.stringify(value));

  // Fields a routine gained later; null keeps each at its default.
  for (const routine of routines) {
    Object.assign(routine, {
      effort: null,
      pace: null,
      caps: null,
      output: null,
      playbookIds: [],
      hook: null,
    });
  }

  Object.assign(handlers, {
    list_agent_inbox: [],
    list_agent_playbooks: [],
    list_agent_subscriptions: [],
    list_agent_chats: () =>
      chats.map(summary).sort((a, b) => b.updatedAt - a.updatedAt),
    get_agent_chat: (args) =>
      copy(chats.find((chat) => chat.id === args.chatId)),
    list_agent_batches: () => [copy(batch)],
    get_agent_task_steps: (args) => {
      const item = batch.tasks.find((t) => t.profileId === args.profileId);
      return item?.lastStep ? [copy(item.lastStep)] : [];
    },
    list_agent_routines: () => copy(routines),
    list_agent_routine_runs: (args) =>
      args.id === "routine-daily" ? copy(routineRuns) : [],
    get_agent_credits: {
      allowance: 10000,
      used: 2350,
      extra: 0,
      balance: 7650,
      periodEnd: new Date(nowMs + 12 * 24 * 60 * MIN).toISOString(),
      plan: "pro",
      unlimited: false,
      freeGrant: null,
      freeGrantAt: null,
    },
    capture_profile_preview: (args) => {
      const page = pageOf.get(args.profileId);
      return page ? shot(page) : null;
    },
    run_agent_routine: (args) => {
      const routine = routines.find((item) => item.id === args.id);
      const started = {
        ...copy(batch),
        id: `run-${Date.now()}`,
        routineId: routine.id,
        prompt: routine.prompt,
        tasks: (args.profileIds || routine.profileIds).map((profileId) => ({
          ...task(data.profiles.find((p) => p.id === profileId).name, "queued"),
        })),
      };
      started.tally = tallyOf(started.tasks);
      return started;
    },
  });

  // The live part: a chat that keeps working and a run that moves on.
  const CHAT_STEPS = [
    ["observe", "Seven new comments on yesterday's post"],
    ["act", "Liking the comment from @nora.k"],
    ["act", "Liking the comment from @tomas_r"],
    ["observe", "One comment asks about shipping to Canada"],
    ["think", "That one needs a reply; asking first"],
  ];
  const CHAT_RESULT =
    "Liked **5** friendly comments. One asks about shipping to Canada; I left it for you.";
  const chatTick = (index) => {
    const chat = chats[2];
    const current = chat.turns[0];
    const at = Date.now();
    if (index < CHAT_STEPS.length) {
      const [kind, value] = CHAT_STEPS[index];
      current.steps = [
        ...current.steps,
        step(
          current.steps.length,
          kind,
          value,
          index === 0 ? "https://social.example.net/posts/2207" : null,
          at,
        ),
      ];
      current.creditsUsed += 7;
    } else {
      current.status = "done";
      current.result = CHAT_RESULT;
      current.finishedAt = at;
    }
    chat.updatedAt = at;
    emit("agent-chat-turn", {
      chatId: chat.id,
      index: 0,
      updatedAt: at,
      turn: copy(current),
    });
  };
  const runTick = (index) => {
    const at = Date.now();
    const order = [
      ["Ads 02", "done"],
      ["Price watch", "running"],
      ["Social · Brand", "step"],
      ["Market research", "step"],
      ["Travel deals", "running"],
      ["Social · Brand", "done"],
    ];
    const [name, change] = order[index % order.length];
    const item = batch.tasks.find((t) => t.profileId === id(name));
    readingIndex += 1;
    if (change === "done") {
      item.status = "done";
      item.result = RESULTS[readingIndex % RESULTS.length];
      item.finishedAt = at;
    } else {
      if (item.status === "queued") item.startedAt = at;
      item.status = "running";
      Object.assign(item, reading(name, item.stepCount));
    }
    batch.tally = tallyOf(batch.tasks);
    emit("agent-batch", copy(batch));
  };

  window.__agentDemo = {
    /** Starts the live part on the page's clock: steps every `every` ms. */
    play({ every = 900, chat = true, run = true, steps = 6 } = {}) {
      for (let n = 0; n < steps; n += 1) {
        window.setTimeout(
          () => {
            if (chat) chatTick(n);
            if (run) runTick(n);
          },
          every * (n + 1),
        );
      }
    },
  };
})();
