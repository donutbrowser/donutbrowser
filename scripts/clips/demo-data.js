// Demo data and command handlers for recorded clips. Every name, address and
// key here is invented. window.__CLIP_DEMO__ (set by the recorder) adjusts a
// take: theme, plan, running profiles, settings.
(() => {
  const options = window.__CLIP_DEMO__ || {};
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  const uuid = (n) =>
    `5d0a${String(n).padStart(4, "0")}-41c2-4e6b-8a1f-${String(n).padStart(12, "0")}`;

  const groups = [
    { id: "g-shops", name: "Shops", sync_enabled: false },
    { id: "g-social", name: "Social", sync_enabled: false },
    { id: "g-research", name: "Research", sync_enabled: false },
    { id: "g-personal", name: "Personal", sync_enabled: false },
  ];
  const proxies = [
    [
      "px-nyc",
      "New York",
      "socks5",
      "us-east.proxy.example",
      1080,
      "US",
      "New York",
    ],
    ["px-lon", "London", "http", "uk.proxy.example", 8080, "GB", "London"],
    ["px-tok", "Tokyo", "socks5", "jp.proxy.example", 1080, "JP", "Tokyo"],
    ["px-ber", "Berlin", "http", "de.proxy.example", 3128, "DE", "Berlin"],
    ["px-tor", "Toronto", "socks5", "ca.proxy.example", 1080, "CA", "Toronto"],
  ].map(([id, name, proxy_type, host, port, country, city]) => ({
    id,
    name,
    proxy_settings: { proxy_type, host, port },
    geo_country: country,
    geo_city: city,
    created_at: now - 30 * DAY,
    updated_at: now - 30 * DAY,
  }));
  const vpns = [
    {
      id: "vpn-zrh",
      name: "Zurich",
      vpn_type: "WireGuard",
      config_data: "",
      created_at: now - 20 * DAY,
    },
  ];
  const statuses = [
    { id: "st-active", name: "Active", color: "#22c55e" },
    { id: "st-warm", name: "Warming up", color: "#f59e0b" },
    { id: "st-review", name: "In review", color: "#3b82f6" },
    { id: "st-banned", name: "Banned", color: "#ef4444" },
  ].map((status, index) => ({
    ...status,
    order: index,
    created_at: now - 40 * DAY,
    updated_at: now - 40 * DAY,
  }));
  const P = (n, name, extra = {}) => ({
    id: uuid(n),
    name,
    browser: "wayfern",
    version: "146.0.7680.31",
    release_type: "stable",
    created_at: now - DAY * (40 - n),
    last_launch: now - 3600 * (n + 2),
    host_os: "macos",
    tags: [],
    ...extra,
    sync_mode: (options.synced || []).includes(name) ? "Regular" : undefined,
    wayfern_config: { os: extra.os || "windows" },
  });
  const profiles = [
    P(1, "Shop · US", {
      group_id: "g-shops",
      proxy_id: "px-nyc",
      tags: ["store"],
      status_id: "st-active",
      dns_blocklist: "pro",
      os: "windows",
    }),
    P(2, "Shop · UK", {
      group_id: "g-shops",
      proxy_id: "px-lon",
      tags: ["store"],
      status_id: "st-active",
      os: "macos",
    }),
    P(3, "Ads 01", {
      group_id: "g-shops",
      proxy_id: "px-tor",
      tags: ["ads"],
      status_id: "st-warm",
      os: "windows",
    }),
    P(4, "Ads 02", {
      group_id: "g-shops",
      proxy_id: "px-ber",
      tags: ["ads"],
      os: "linux",
    }),
    P(5, "Social · Main", {
      group_id: "g-social",
      proxy_id: "px-nyc",
      tags: ["social"],
      status_id: "st-active",
      os: "macos",
    }),
    P(6, "Social · Brand", {
      group_id: "g-social",
      proxy_id: "px-ber",
      tags: ["social"],
      os: "windows",
    }),
    P(7, "Forum", {
      group_id: "g-social",
      vpn_id: "vpn-zrh",
      tags: ["social"],
      status_id: "st-review",
      os: "linux",
    }),
    P(8, "Market research", {
      group_id: "g-research",
      proxy_id: "px-tok",
      tags: ["research"],
      os: "windows",
    }),
    P(9, "Price watch", {
      group_id: "g-research",
      proxy_id: "px-ber",
      tags: ["research"],
      os: "macos",
    }),
    P(10, "Banking", {
      group_id: "g-personal",
      vpn_id: "vpn-zrh",
      tags: ["private"],
      password_protected: true,
      os: "macos",
    }),
    P(11, "Travel deals", {
      group_id: "g-personal",
      proxy_id: "px-tok",
      os: "windows",
    }),
    P(12, "Throwaway", {
      group_id: "g-personal",
      os: "linux",
      clear_on_close: true,
    }),
  ];
  const extensions = [
    ["ext-ub", "uBlock Origin Lite", "2025.9"],
    ["ext-pw", "Password manager", "2025.10"],
    ["ext-dk", "Dark Reader", "4.9"],
  ].map(([id, name, version]) => ({
    id,
    name,
    file_name: `${id}.crx`,
    file_type: "crx",
    browser_compatibility: ["chromium"],
    created_at: now - 30 * DAY,
    updated_at: now - 30 * DAY,
    source_kind: "archive",
    version,
  }));
  const extensionGroups = [
    {
      id: "eg-work",
      name: "Work kit",
      extension_ids: ["ext-ub", "ext-pw"],
      created_at: now - 30 * DAY,
      updated_at: now - 30 * DAY,
    },
  ];
  const paidUser = {
    id: "u-demo",
    email: "you@example.com",
    plan: "pro",
    planPeriod: "monthly",
    subscriptionStatus: "active",
    profileLimit: 0,
    cloudProfilesUsed: 4,
    proxyBandwidthLimitMb: 0,
    proxyBandwidthUsedMb: 0,
    proxyBandwidthExtraMb: 0,
    deviceOrdinal: 1,
    deviceCount: 1,
    isPrimaryDevice: true,
    entitlements: {
      active: true,
      browserAutomation: true,
      crossOsFingerprints: true,
      cloudBackup: true,
      teamCollaboration: true,
      cookieBot: true,
      remoteInteractive: true,
      remoteControl: true,
      agent: options.agentPlan === true,
      profileLimit: 0,
      requestsPerHour: 5000,
      remoteBrowserHours: 10,
    },
  };

  const running = new Set((options.running || []).map(uuid));
  const demo = {
    profiles,
    proxies,
    vpns,
    groups,
    statuses,
    extensions,
    extensionGroups,
    running,
    user: options.paid === false ? null : paidUser,
    trash: options.trash
      ? [
          {
            id: uuid(31),
            name: "Test checkout",
            browser: "wayfern",
            version: "146.0.7680.31",
            deleted_at: now - 6 * DAY,
            expires_at: now + 24 * DAY,
            size_bytes: 92_000_000,
            group_id: "g-shops",
            password_protected: false,
            sync_enabled: false,
          },
          {
            id: uuid(30),
            name: "Old storefront",
            browser: "wayfern",
            version: "146.0.7680.31",
            deleted_at: now - 2 * DAY,
            expires_at: now + 28 * DAY,
            size_bytes: 184_000_000,
            group_id: "g-shops",
            password_protected: false,
            sync_enabled: false,
          },
        ]
      : [],
    templates: [
      {
        id: "tpl-shop",
        name: "Shop starter",
        settings: {
          group_id: "g-shops",
          proxy_ids: ["px-nyc", "px-lon", "px-ber"],
          tags: ["store"],
          status_id: "st-warm",
          dns_blocklist: "pro",
          wayfern_config: { os: "windows" },
        },
        position: 0,
        updated_at: now,
      },
    ],
  };
  demo.locks = (options.locks || []).map((lock) => ({
    profileId: uuid(lock.profile),
    lockedBy: "u-teammate",
    lockedByEmail: lock.email,
    lockedAt: new Date(Date.now() - 600_000).toISOString(),
  }));
  const nowMs = Date.now();
  demo.console = options.agents
    ? {
        sessions: [
          {
            session_id: "s-1",
            client_name: "claude-code",
            client_version: "2.4.0",
            connected_at: nowMs - 1000 * 1500,
            last_seen_at: nowMs - 1000 * 4,
            calls: 86,
            errors: 0,
            ended: false,
            status: {
              message: "Checking orders",
              done: 3,
              total: 8,
              profile_id: uuid(1),
              updated_at: nowMs - 1000 * 6,
            },
          },
        ],
        activity: [
          ["navigate", 1, "shop.example.com"],
          ["click", 1, null],
          ["type", 1, "18"],
          ["screenshot", 1, null],
          ["navigate", 2, "shop.example.com"],
        ].map(([tool, n, detail], index) => ({
          id: index + 1,
          at: nowMs - 1000 * (60 - index * 9),
          session_id: "s-1",
          tool,
          profile_id: uuid(n),
          profile_count: null,
          ok: true,
          error_code: null,
          duration_ms: 420 + index * 130,
          detail,
        })),
        thread: [
          {
            id: 7,
            at: nowMs - 1000 * 20,
            kind: "question",
            session_id: "s-1",
            text: "Order 1042 has two shipping addresses. Which one should I use?",
            profile_id: uuid(1),
            choices: ["The billing address", "The newest one"],
            state: "open",
            answer: null,
            answered_at: null,
            delivered_to: [],
            done: null,
            total: null,
            feedback: null,
          },
        ],
        holds: [],
        paused: null,
        quota: null,
      }
    : {
        sessions: [],
        activity: [],
        thread: [],
        holds: [],
        paused: null,
        quota: null,
      };
  window.__CLIP_DATA__ = demo;

  const settings = {
    set_as_default_browser: false,
    theme: options.theme || "dark",
    custom_theme: null,
    api_enabled: false,
    api_port: 10108,
    api_token: null,
    sync_server_url: null,
    first_launch_timestamp: now - 60 * DAY,
    commercial_trial_acknowledged: true,
    mcp_remote_enabled: false,
    language: "en",
    window_resize_warning_dismissed: true,
    fingerprint_gate_disabled: false,
    vpn_extension_warning_disabled: true,
    onboarding_completed: true,
    disable_auto_updates: true,
    keep_decrypted_profiles_in_ram: false,
    tips_auto_show: false,
    tips_seen: [],
    tips_used: [],
    paid_welcome_seen_for: ["u-demo"],
    cloud_plan_memory: {},
    require_route_for_launch: false,
    trash_retention_days: 30,
    record_traffic_domains: false,
    ...(options.settings || {}),
  };

  const withRunning = () =>
    demo.profiles.map((profile) =>
      running.has(profile.id)
        ? { ...profile, process_id: 40000 + Number(profile.id.slice(4, 8)) }
        : profile,
    );
  const addProfile = (name, extra = {}) => {
    const n = demo.profiles.length + 1;
    const profile = {
      id: uuid(n),
      name,
      browser: "wayfern",
      version: "146.0.7680.31",
      release_type: "stable",
      created_at: Math.floor(Date.now() / 1000),
      host_os: "macos",
      tags: extra.tags || [],
      proxy_id: extra.proxy_id || undefined,
      vpn_id: extra.vpn_id || undefined,
      group_id: extra.group_id || undefined,
      status_id: extra.status_id || undefined,
      dns_blocklist: extra.dns_blocklist || undefined,
      wayfern_config: { os: extra.os || "windows" },
    };
    demo.profiles.push(profile);
    window.__clipEmit("profiles-changed", null);
    return profile;
  };
  const emitProfiles = () => window.__clipEmit?.("profiles-changed", null);
  const updateProfile = (id, patch) => {
    const profile = demo.profiles.find((item) => item.id === id);
    if (profile) Object.assign(profile, patch);
    emitProfiles();
    return profile ? { ...profile } : null;
  };
  const checkFor = (proxy) => {
    const zones = {
      US: "America/New_York",
      GB: "Europe/London",
      JP: "Asia/Tokyo",
      DE: "Europe/Berlin",
      CA: "America/Toronto",
    };
    const ips = {
      US: "203.0.113.24",
      GB: "198.51.100.71",
      JP: "203.0.113.140",
      DE: "198.51.100.17",
      CA: "192.0.2.204",
    };
    return {
      ip: ips[proxy.geo_country],
      city: proxy.geo_city,
      country: proxy.geo_country,
      country_code: proxy.geo_country,
      timestamp: now - 120,
      is_valid: true,
      isp: "Residential ISP",
      timezone: zones[proxy.geo_country],
      udp: "yes",
      latency_ms: 140 + ((proxy.id.length * 37) % 120),
    };
  };

  window.__HANDLERS__ = {
    get_app_settings: () => ({ ...settings }),
    save_app_settings: (args) => {
      Object.assign(settings, args.settings || {});
      return { ...settings };
    },
    get_system_language: "en",
    get_window_decoration_layout: { client_side: false, layout: null },
    update_tray_menu: null,
    get_stored_proxies: () => demo.proxies,
    list_vpn_configs: () => demo.vpns,
    cloud_get_user: () =>
      demo.user
        ? {
            user: demo.user,
            logged_in_at: new Date(Date.now() - DAY * 3000).toISOString(),
          }
        : null,
    get_team_locks: () => demo.locks || [],
    list_browser_profiles: () => withRunning(),
    get_groups_with_profile_counts: () =>
      demo.groups.map((group) => ({
        ...group,
        count: demo.profiles.filter((p) => p.group_id === group.id).length,
      })),
    get_profile_groups: () => demo.groups,
    get_groups: () => demo.groups,
    list_profile_statuses: () => demo.statuses,
    list_extension_groups: () => demo.extensionGroups,
    list_extensions: () => demo.extensions,
    get_cached_proxy_check: (args) => {
      const proxy = demo.proxies.find((item) => item.id === args.proxyId);
      if (!proxy) return null;
      if (
        (options.unchecked || []).includes(proxy.id) &&
        !demo.checked?.[proxy.id]
      ) {
        return null;
      }
      return checkFor(proxy);
    },
    check_missing_binaries: [],
    get_profile_creation_allowance: {
      enforcement: "soft",
      per_hour: 1000,
      used: 3,
      remaining: 997,
      retry_after_secs: null,
    },
    get_browser_release_types: { stable: "146.0.7680.31" },
    get_downloaded_browser_versions: ["146.0.7680.31"],
    is_geoip_database_available: true,
    get_api_server_status: null,
    check_has_e2e_password: false,
    get_system_info: {
      os: "macos",
      os_version: "26.0",
      arch: "aarch64",
      app_version: "0.36.0",
      portable: false,
    },
    get_profile_traffic_snapshot: null,
    get_profile_cookie_stats: { total_count: 312 },
    get_extension_icon: null,
    is_proxy_in_use_by_synced_profile: false,
    is_vpn_in_use_by_synced_profile: false,
    is_group_in_use_by_synced_profile: false,
    observe_cloud_plan: false,
    get_sync_settings: { sync_server_url: null, sync_token: null },
    get_sync_sessions: [],
    check_wayfern_terms_accepted: true,
    check_wayfern_downloaded: true,
    check_browser_exists: true,
    ensure_active_browsers_downloaded: [],
    get_commercial_trial_status: { type: "Expired" },
    has_acknowledged_trial_expiration: true,
    get_tips_state: () => ({
      auto_show: settings.tips_auto_show,
      seen: settings.tips_seen,
      used: settings.tips_used,
      inline: null,
      last_auto_shown_at: null,
      next_auto_show_at: null,
    }),
    "plugin:deep-link|get_current": null,
    "plugin:log|log": null,
    "plugin:macos-permissions|check_microphone_permission": true,
    "plugin:macos-permissions|check_camera_permission": true,
    get_all_tags: () => [...new Set(demo.profiles.flatMap((p) => p.tags))],
    check_for_app_updates: null,
    get_table_preferences: () => ({
      sizing: {},
      sorting: [],
      density: "comfortable",
      visibility: {},
      ...(options.tablePrefs || {}),
    }),
    save_table_preferences: null,
    get_onboarding_completed: true,
    is_default_browser: () => demo.isDefault === true,
    get_proxy_check_history: [],
    list_trashed_profiles: () => [...demo.trash],
    list_trashed_entities: [],
    list_profile_templates: () => [...demo.templates],
    create_profile_template: (args) => {
      const template = {
        id: `tpl-${demo.templates.length + 1}`,
        name: args.name,
        settings: args.settings || {},
        position: demo.templates.length,
        updated_at: now,
      };
      demo.templates.push(template);
      window.__clipEmit("profile-templates-changed", null);
      return template;
    },
    create_browser_profile_new: (args) =>
      addProfile(args.name, {
        proxy_id: args.proxyId,
        vpn_id: args.vpnId,
        group_id: args.groupId,
        dns_blocklist: args.dnsBlocklist,
        os: args.wayfernConfig?.os,
      }),
    bulk_create_profiles: async (args) => {
      const settings = args.settings || {};
      const created = [];
      for (let i = 0; i < args.count; i += 1) {
        const proxies = settings.proxy_ids || [];
        created.push(
          addProfile(args.count > 1 ? `${args.name} ${i + 1}` : args.name, {
            proxy_id: proxies.length
              ? proxies[i % proxies.length]
              : settings.proxy_id,
            vpn_id: settings.vpn_id,
            group_id: settings.group_id,
            tags: settings.tags,
            status_id: settings.status_id,
            dns_blocklist: settings.dns_blocklist,
            os: settings.wayfern_config?.os,
          }),
        );
        window.__clipEmit("profiles-bulk-create-progress", {
          done: i + 1,
          total: args.count,
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return { created, error: null, cancelled: false };
    },
    set_profile_password: (args) =>
      updateProfile(args.profileId, { password_protected: true }),
    update_profile_clear_on_close: (args) =>
      updateProfile(args.profileId, { clear_on_close: args.clearOnClose }),
    generate_totp_code: () => {
      const period = 30;
      const step = Math.floor(Date.now() / 1000 / period);
      return {
        code: String(100000 + ((step * 7919) % 900000)).padStart(6, "0"),
        valid_until: (step + 1) * period,
        period,
      };
    },
    restore_trashed_profile: (args) => {
      const index = demo.trash.findIndex((item) => item.id === args.profileId);
      const [item] = demo.trash.splice(index, 1);
      window.__clipEmit("trash-changed", null);
      return addProfile(item.name, { group_id: item.group_id });
    },
    set_as_default_browser: () => {
      settings.set_as_default_browser = true;
      demo.isDefault = true;
      return { status: "set" };
    },
    get_all_traffic_snapshots: () => {
      const t = Math.floor(Date.now() / 1000);
      return [...running].map((id, k) => {
        const points = [];
        for (let i = 59; i >= 0; i -= 1) {
          const x = (t - i) * 0.37 + k * 11;
          const v =
            Math.max(0, Math.sin(x) * 0.5 + Math.sin(x * 0.31) * 0.8 + 1.2) *
            180000 *
            (1 + k * 0.4);
          points.push({
            timestamp: t - i,
            bytes_sent: Math.round(v * 0.12),
            bytes_received: Math.round(v),
          });
        }
        const last = points[points.length - 1];
        return {
          profile_id: id,
          session_start: t - 900,
          last_update: t,
          total_bytes_sent: 18_400_000,
          total_bytes_received: 214_000_000,
          total_requests: 4210,
          current_bytes_sent: last.bytes_sent,
          current_bytes_received: last.bytes_received,
          recent_bandwidth: points,
        };
      });
    },
    start_api_server: (args) => {
      settings.api_enabled = true;
      return args.port || 10108;
    },
    stop_api_server: () => {
      settings.api_enabled = false;
      return null;
    },
    send_feedback: () => ({ id: "fb-1042" }),
    note_tip_feature_used: null,
    get_profile_pre_launch_checks: (args) => {
      const profile = demo.profiles.find((item) => item.id === args.profileId);
      const mismatch =
        (options.mismatch || []).includes(profile?.name) && !demo.matched;
      return {
        consistency: mismatch
          ? {
              consistent: false,
              checked: true,
              exit_ip: "203.0.113.140",
              exit_country_code: "JP",
              exit_timezone: "Asia/Tokyo",
              fingerprint_timezone: "America/New_York",
              fingerprint_language: "en-US",
              mismatches: ["timezone", "language"],
              unverified: [],
            }
          : {
              consistent: true,
              checked: true,
              exit_ip: null,
              exit_country_code: null,
              exit_timezone: null,
              fingerprint_timezone: null,
              fingerprint_language: null,
              mismatches: [],
              unverified: [],
            },
        vpn_extensions: [],
        scan_state: "scanned",
        exit_measurement_unreliable: false,
        exit_probe_pending: false,
        exit_unverified: [],
        route_unreachable: null,
        route_missing: false,
        consent_token: null,
      };
    },
    match_profile_fingerprint_to_exit: () => {
      demo.matched = true;
      return null;
    },
    ack_launch_gate: null,
    check_sync_server_connection: async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return {
        server_reachable: true,
        storage_ready: true,
        storage_endpoint: "https://s3.example.com",
        storage_reachable: true,
        storage_error: null,
      };
    },
    save_sync_settings: (args) => ({
      sync_server_url: args.syncServerUrl ?? null,
      sync_token: args.syncToken ?? null,
    }),
    restart_sync_service: null,
    get_cookie_bot_runs: { runs: [] },
    get_cookie_bot_usage: null,
    get_cookie_bot_presets: {
      presets: [
        { id: "light", typical_minutes: 10, recommended: false, name: "Light" },
        {
          id: "standard",
          typical_minutes: 20,
          recommended: true,
          name: "Standard",
        },
        { id: "deep", typical_minutes: 40, recommended: false, name: "Deep" },
      ],
      default_preset: "standard",
      templates: [
        {
          id: "shopping",
          site_count: 40,
          name: "Shopping",
          description: "Stores, deals and reviews",
        },
        {
          id: "news",
          site_count: 35,
          name: "News",
          description: "News sites and blogs",
        },
      ],
      limits: null,
    },
    get_cookie_bot_user_templates: [],
    list_profile_totp: [],
    detect_existing_profiles: [
      ["chrome", "Work", "Google Chrome · Profile 1"],
      ["edge", "Personal", "Microsoft Edge · Default"],
      ["brave", "Research", "Brave · Profile 2"],
    ].map(([browser, name, description]) => ({
      browser,
      name,
      path: `/Users/you/Library/Application Support/${browser}/${name}`,
      description,
      mapped_browser: "wayfern",
    })),
    import_browser_profiles: async (args) => {
      const results = [];
      for (const item of args.items) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const profile = addProfile(item.name || "Imported", {
          group_id: args.groupId,
        });
        results.push({
          name: profile.name,
          source_path: item.source_path,
          status: "imported",
          profile_id: profile.id,
          error: null,
          report: {
            cookies_migrated: 1284,
            cookies_unrecoverable: 0,
            passwords_migrated: 36,
            passwords_unrecoverable: 0,
            payment_methods_migrated: 0,
            payment_methods_unrecoverable: 0,
            extensions_migrated: 4,
            history_entries: 5120,
            bookmarks: 48,
            local_storage_origins: 61,
            bytes_copied: 212_000_000,
            warnings: [],
          },
        });
      }
      return {
        imported_count: results.length,
        skipped_count: 0,
        failed_count: 0,
        results,
      };
    },
    check_proxy_validity: async (args) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      const proxy = demo.proxies.find((item) => item.id === args.proxyId);
      demo.checked = { ...(demo.checked || {}), [args.proxyId]: true };
      return { ...checkFor(proxy), timestamp: Math.floor(Date.now() / 1000) };
    },
    get_proxy_check_history: (args) => {
      const proxy = demo.proxies.find((item) => item.id === args.proxyId);
      if (!proxy) return [];
      const check = checkFor(proxy);
      return [0, 1, 2, 3, 4, 5].map((k) => ({
        timestamp: now - k * 3 * 3600,
        ok: k !== 3,
        ip: check.ip,
        country: check.country,
        country_code: check.country_code,
        isp: check.isp,
        udp: "yes",
        latency_ms: check.latency_ms + ((k * 53) % 70) - 30,
      }));
    },
    get_profile_site_storage: null,
    get_profile_activity: null,
    check_browser_status: (args) => running.has(args.profile?.id),
    is_profile_locked: false,
    launch_browser_profile: (args) => {
      const id = args.profile?.id;
      if (
        settings.require_route_for_launch &&
        !args.profile?.proxy_id &&
        !args.profile?.vpn_id
      ) {
        return new Error(JSON.stringify({ code: "PROFILE_ROUTE_REQUIRED" }));
      }
      setTimeout(() => {
        running.add(id);
        window.__clipEmit("profile-running-changed", { id, is_running: true });
      }, 700);
      return { ...args.profile, process_id: 41000 };
    },
    kill_browser_profile: (args) => {
      const id = args.profile?.id;
      running.delete(id);
      setTimeout(
        () =>
          window.__clipEmit("profile-running-changed", {
            id,
            is_running: false,
          }),
        200,
      );
      return null;
    },
    get_sync_health: null,
    get_version_update_status: [now - 600, 3600],
    take_whats_new: null,
    get_remote_handoff_states: {},
    get_agent_console: () => demo.console,
    answer_agent_request: (args) => {
      const item = demo.console.thread.find(
        (entry) => entry.id === args.requestId,
      );
      Object.assign(item, {
        state: "answered",
        answer: args.answer,
        answered_at: Date.now(),
      });
      window.__clipEmit("agent-console-thread", item);
      return item;
    },
    send_agent_note: (args) => {
      const item = {
        id: demo.console.thread.length + 10,
        at: Date.now(),
        kind: "note",
        session_id: args.sessionId ?? null,
        text: args.text,
        profile_id: args.profileId ?? null,
        choices: [],
        state: "delivered",
        answer: null,
        answered_at: null,
        delivered_to: ["s-1"],
        done: null,
        total: null,
        feedback: null,
      };
      demo.console.thread.push(item);
      window.__clipEmit("agent-console-thread", item);
      return item;
    },
    take_over_profile: (args) => {
      const hold = {
        profile_id: args.profileId,
        since: Date.now(),
        note: args.note ?? null,
        request_id: null,
      };
      demo.console.holds = [hold];
      window.__clipEmit("agent-console-state", {
        holds: demo.console.holds,
        paused: null,
        quota: null,
      });
      return hold;
    },
    get_agent_engine_status: null,
    get_agent_chat_sync: { locked: false },
    list_agent_batches: [],
    list_agent_chats: [],
    watch_agent_chats: null,
    list_agent_routines: [],
    get_agent_credits: null,
    start_remote_session_events: null,
    stop_remote_session_events: null,
    get_cookie_bot_schedules: { schedules: [], team_id: null, scope: "user" },
    get_remote_hours_quota: {
      granted_hours: 10,
      remaining_hours: 8.5,
      used_hours: 1.5,
      scope: "user",
      seats: 1,
      per_seat_hours: 10,
    },
    take_reopen_profiles: [],
    get_window_resize_warning_dismissed: true,
    check_missing_geoip_database: false,
    get_app_proxy: null,
    read_app_log: "",
    list_mcp_agents: () =>
      [
        ["claude-code", "Claude Code", "cli", true],
        ["claude-desktop", "Claude Desktop", "desktop-app", false],
        ["cursor", "Cursor", "editor", false],
        ["codex", "Codex", "cli", false],
        ["vscode", "VS Code", "editor", false],
      ].map(([id, display_name, category, connected]) => ({
        id,
        display_name,
        category,
        connected,
        detected: true,
      })),
    get_mcp_remote_status: () => ({
      enabled: settings.mcp_remote_enabled,
      connected: settings.mcp_remote_enabled,
      instanceId: "a41f",
      lastError: null,
    }),
    get_mcp_remote_credential: { present: false, tokenPrefix: null },
    set_profiles_status: (args) => {
      for (const id of args.profileIds) {
        updateProfile(id, { status_id: args.statusId ?? null });
      }
      return null;
    },
    update_profile_dns_blocklist: (args) =>
      updateProfile(args.profileId, {
        dns_blocklist: args.dnsBlocklist ?? null,
      }),
    assign_extension_group_to_profile: (args) =>
      updateProfile(args.profileId, {
        extension_group_id: args.extensionGroupId ?? null,
      }),
    update_profile_proxy: (args) =>
      updateProfile(args.profileId, {
        proxy_id: args.proxyId ?? null,
        vpn_id: null,
      }),
    update_profile_vpn: (args) =>
      updateProfile(args.profileId, {
        vpn_id: args.vpnId ?? null,
        proxy_id: null,
      }),
    set_profile_sync_mode: (args) => {
      const profile = updateProfile(args.profileId, {
        sync_mode: args.syncMode,
      });
      const report = (status) =>
        window.__clipEmit("profile-sync-status", {
          profile_id: args.profileId,
          status,
        });
      if (args.syncMode !== "Disabled") {
        setTimeout(() => report("syncing"), 300);
        setTimeout(() => report("synced"), 1500);
      }
      return profile;
    },
    list_restore_points: [],
    get_profile_debug_endpoint: (args) =>
      running.has(args.profileId)
        ? {
            port: 9222,
            ws_url:
              "ws://127.0.0.1:9222/devtools/browser/4f1c8e2a-9b7d-4a63-b0e5-2d8c6f1a7e94",
          }
        : null,
    get_remote_control_entitlement: true,
    start_mcp_remote_bridge: () => {
      settings.mcp_remote_enabled = true;
      return {
        enabled: true,
        connected: true,
        instanceId: "a41f",
        lastError: null,
      };
    },
    stop_mcp_remote_bridge: () => {
      settings.mcp_remote_enabled = false;
      return {
        enabled: false,
        connected: false,
        instanceId: "a41f",
        lastError: null,
      };
    },
  };
})();
