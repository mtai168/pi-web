import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");

async function withHookRuntime(run) {
  const react = createRequire(import.meta.url)("react");
  const names = ["useState", "useRef", "useReducer", "useMemo", "useCallback", "useEffect", "useLayoutEffect"];
  const oldReact = Object.fromEntries(names.map((name) => [name, react[name]]));
  const globals = ["fetch", "EventSource", "setTimeout"];
  const oldGlobals = Object.fromEntries(globals.map((name) => [name, globalThis[name]]));
  let slots = [], cursor = 0, mounted = false, effects = [], cleanups = [], activeUnmount;
  const getSlot = (factory) => slots[cursor++] ??= factory();
  react.useState = (initial) => { const slot = getSlot(() => ({ value: typeof initial === "function" ? initial() : initial })); slot.set ??= (update) => { slot.value = typeof update === "function" ? update(slot.value) : update; }; return [slot.value, slot.set]; };
  react.useRef = (initial) => getSlot(() => ({ current: initial }));
  react.useReducer = (reduce, initial) => { const slot = getSlot(() => ({ value: initial })); slot.dispatch ??= (action) => { slot.value = reduce(slot.value, action); }; return [slot.value, slot.dispatch]; };
  react.useMemo = (factory) => getSlot(() => ({ value: factory() })).value;
  react.useCallback = (callback) => { cursor++; return callback; };
  const effect = (callback) => { cursor++; if (!mounted) effects.push(callback); };
  react.useEffect = effect; react.useLayoutEffect = effect;

  class FakeEventSource {
    static sources = []; readyState = 0; onmessage = null; onerror = null; closeCount = 0;
    constructor(url) { this.url = url; FakeEventSource.sources.push(this); }
    message(event) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(event) }); }
    error() { this.readyState = 2; this.onerror?.(new Event("error")); }
    close() { this.readyState = 2; this.closeCount += 1; }
  }
  globalThis.EventSource = FakeEventSource;
  const realSetTimeout = oldGlobals.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 1000 || delay === 30000 ? 0 : delay, ...args);
  try {
    const { useAgentSession } = await createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }).import("./useAgentSession.ts");
    const make = (options, fetchImpl) => {
      slots = []; cursor = 0; mounted = false; effects = []; cleanups = [];
      globalThis.fetch = fetchImpl; FakeEventSource.sources = [];
      const unmount = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); };
      activeUnmount = unmount;
      return { useHook() { cursor = 0; const value = useAgentSession(options); if (!mounted) { mounted = true; for (const callback of effects.splice(0)) { const cleanup = callback(); if (typeof cleanup === "function") cleanups.push(cleanup); } } return value; }, unmount };
    };
    const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); };
    await run({ make, FakeEventSource, flush });
  } finally {
    activeUnmount?.();
    for (const name of names) react[name] = oldReact[name];
    for (const name of globals) { if (oldGlobals[name] === undefined) delete globalThis[name]; else globalThis[name] = oldGlobals[name]; }
  }
}

test("keeps the session event stream open through the idle grace window", () => {
  const finishSource = source.slice(
    source.indexOf("const finishPromptWithoutStream"),
    source.indexOf("const waitForPromptSettlement"),
  );
  const graceSource = source.slice(
    source.indexOf("const scheduleEventStreamClose"),
    source.indexOf("const finishPromptWithoutStream"),
  );
  const agentEndSource = source.slice(
    source.indexOf('case "agent_end"'),
    source.indexOf('case "agent_settled"'),
  );
  const agentStartSource = source.slice(
    source.indexOf('case "agent_start"'),
    source.indexOf('case "agent_end"'),
  );
  const agentSettledSource = source.slice(
    source.indexOf('case "agent_settled"'),
    source.indexOf('case "prompt_done"'),
  );
  const promptDoneSource = source.slice(
    source.indexOf('case "prompt_done"'),
    source.indexOf('case "prompt_error"'),
  );
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  assert.match(source, /const EVENT_STREAM_IDLE_GRACE_MS = 30_000/);
  assert.match(graceSource, /setTimeout\(\(\) => void checkServerIdle\(\), EVENT_STREAM_IDLE_GRACE_MS\)/);
  assert.match(graceSource, /fetch\(`\/api\/agent\/\$\{encodeURIComponent\(sid\)\}`\)/);
  assert.match(graceSource, /closeEvents\(\)/);
  assert.match(finishSource, /scheduleEventStreamClose\(sid\)/);
  assert.doesNotMatch(finishSource, /closeEvents\(\)/);
  assert.doesNotMatch(agentEndSource, /closeEvents\(\)/);
  assert.match(agentStartSource, /cancelEventStreamGrace\(\)/);
  assert.match(agentSettledSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(agentSettledSource, /onAgentEnd\?\.\(\)/);
  assert.match(promptDoneSource, /notifyPromptStage\(runId\)/);
  assert.match(promptDoneSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(sendSource, /const definitivelyRejected = !promptRequestStarted/);
  assert.match(sendSource, /if \(!definitivelyRejected && sentSessionId\) \{[\s\S]*?waitForPromptSettlement/);
  assert.match(sendSource, /restoreSubmission\(message, images, composerDraftKey\);[\s\S]*?if \(sentSessionId\) \{[\s\S]*?reconcileAgentState\(sentSessionId\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?closeEvents\(\)/);
  assert.doesNotMatch(
    sendSource,
    /rpcPromptPendingRef\.current = false;\s*agentRunningRef\.current = false;\s*closeEvents\(\)/,
  );
});

test("a rejected submission preserves a different run reported by the server", () => {
  const reconcileSource = source.slice(
    source.indexOf("  const reconcileAgentState = useCallback"),
    source.indexOf("  // Recovery net for missed SSE events"),
  );

  assert.match(reconcileSource, /sessionIdRef\.current !== sid/);
  assert.match(reconcileSource, /if \(busy\) \{[\s\S]*?sdkAgentActiveRef\.current = Boolean\(state\.isStreaming\)/);
  assert.match(reconcileSource, /rpcPromptPendingRef\.current = Boolean\(state\.isPromptRunning\)/);
  assert.match(reconcileSource, /if \(!agentRunningRef\.current\) return;[\s\S]*?finishPromptWithoutStream/);
});

test("opening System or Tools lazily starts a dormant session without sending a prompt", () => {
  const loadSystemInfoSource = source.slice(
    source.indexOf("  const loadSystemInfo = useCallback"),
    source.indexOf("  const loadSlashCommands = useCallback"),
  );
  const loaderEffectSource = source.slice(
    source.indexOf("  useEffect(() => {\n    onSystemInfoLoaderChange"),
    source.indexOf("  useEffect(() => {\n    if (!onBranchDataChange) return;"),
  );

  assert.match(loadSystemInfoSource, /sessionIdRef\.current \?\? await ensureNewSession\(signal\)/);
  assert.doesNotMatch(loadSystemInfoSource, /promoteNewSession\(\)/);
  assert.match(loadSystemInfoSource, /sendAgentCommand<AgentStateResponse>\(sid, \{ type: "get_state" \}\)/);
  assert.match(loadSystemInfoSource, /loadTools\(sid, signal\)/);
  assert.doesNotMatch(loadSystemInfoSource, /type: "prompt"/);
  assert.match(loadSystemInfoSource, /setSystemPrompt\(state\.systemPrompt \?\? ""\)/);
  // Abort plumbing: an obsolete pane's run is checked before session creation
  // and between every awaited stage, so it never starts a later side effect.
  assert.match(loadSystemInfoSource, /ensureNewSession\(signal\)/);
  assert.match(loadSystemInfoSource, /if \(!sid \|\| signal\?\.aborted\) return;/);
  assert.match(loadSystemInfoSource, /if \(signal\?\.aborted \|\| !sessionHookMountedRef\.current \|\| sessionIdRef\.current !== sid\) return;/);
  assert.match(loaderEffectSource, /onSystemInfoLoaderChange\?\.\(loadSystemInfo\)/);
  assert.match(loaderEffectSource, /onSystemInfoLoaderChange\?\.\(null\)/);
  assert.match(appShellSource, /onClick=\{\(\) => handleSystemInfoToggle\("system", mobile\)\}/);
  assert.match(appShellSource, /onClick=\{\(\) => handleSystemInfoToggle\("tools", mobile\)\}/);
  assert.match(appShellSource, /systemInfoLoaderControllerRef\.current/);
  assert.doesNotMatch(appShellSource, /systemPrompt !== null \|\| systemInfoLoading/);
  for (const handlerName of ["handleSystemInfoToggle", "handleWallSystemInfoToggle"]) {
    const handlerStart = appShellSource.indexOf(`  const ${handlerName} = useCallback`);
    const handlerSource = appShellSource.slice(
      handlerStart,
      appShellSource.indexOf("\n  const ", handlerStart + 1),
    );
    assert.match(handlerSource, /systemInfoLoaderControllerRef\.current\?\.start\(opening\)/);
    assert.match(handlerSource, /complete\(started\.loadId\)/);
  }
  assert.match(
    appShellSource,
    /handleSystemInfoLoaderChange[\s\S]*?register\(loader\)[\s\S]*?setSystemInfoLoading\(false\)/,
  );
});

test("ensureNewSession refuses to create a session for an aborted loader run", () => {
  const ensureNewSessionSource = source.slice(
    source.indexOf("  const ensureNewSession = useCallback"),
    source.indexOf("  // Opening the System or Tools panel"),
  );
  // The abort is checked before the ensure_session request is issued, so an
  // obsolete pane cannot initialize a session after it was replaced.
  assert.match(ensureNewSessionSource, /signal\?\.aborted/);
  assert.match(ensureNewSessionSource, /throw new DOMException\("Aborted", "AbortError"\)/);
  // The shared promise is never bound to one caller's signal: aborting a
  // superseded loader run must not cancel the send flow awaiting the same
  // promise; an already-issued request is not rolled back, its late result
  // is discarded by the caller.
  assert.doesNotMatch(ensureNewSessionSource, /fetch\("\/api\/agent\/new", \{[\s\S]*?signal/);
});

test("loadTools discards late results and stays silent when its run is aborted", () => {
  const loadToolsSource = source.slice(
    source.indexOf("  const loadTools = useCallback"),
    source.indexOf("  const promoteNewSession = useCallback"),
  );
  assert.match(loadToolsSource, /async \(sid: string, signal\?: AbortSignal\) => \{/);
  assert.match(loadToolsSource, /if \(signal\?\.aborted\) return null;/);
  assert.match(loadToolsSource, /if \(signal\?\.aborted \|\| !tools \|\| !sessionHookMountedRef\.current \|\| sessionIdRef\.current !== sid\) return null;/);
  // loadTools' command fetch does not carry the run's signal, so its errors
  // are always genuine and must not be hidden by a superseded run.
  assert.match(loadToolsSource, /console\.error\("Failed to load tools:", e\);/);
  assert.doesNotMatch(loadToolsSource, /signal\?\.aborted\) console\.error/);
});

test("new-session promotion rekeys drafts before publishing the real session", () => {
  const promoteSource = source.slice(
    source.indexOf("  const promoteNewSession = useCallback"),
    source.indexOf("  const ensureNewSession = useCallback"),
  );

  assert.match(promoteSource, /draftKeyAliasesRef\.current\.set\(provisionalDraftKey, sid\)/);
  assert.match(promoteSource, /input\.rekeyDraft\(provisionalDraftKey, sid\)/);
  assert.ok(
    promoteSource.indexOf("input.rekeyDraft(provisionalDraftKey, sid)")
      < promoteSource.indexOf("onSessionCreated?.({"),
  );
  assert.match(promoteSource, /}, provisionalDraftKey\)/);
  assert.match(chatWindowSource, /draftKey=\{session\?\.id \?\? newSessionDraftKey \?\? undefined\}/);
});

test("fresh sessions use the preference while persisted and live sessions restore their selection", () => {
  const preferenceSource = source.slice(
    source.indexOf("  const setToolPresetState"),
    source.indexOf("  const scrollToBottom"),
  );
  const loadToolsSource = source.slice(
    source.indexOf("  const loadTools = useCallback"),
    source.indexOf("  const promoteNewSession"),
  );
  const changeSource = source.slice(
    source.indexOf("  const handleToolPresetChange = useCallback"),
    source.indexOf("  const scrollUserMsgToTop"),
  );

  assert.match(
    preferenceSource,
    /const existingSessionId = session\?\.id;[\s\S]*?useLayoutEffect\(\(\) => \{\s*if \(!existingSessionId && \(!isNew \|\| sessionIdRef\.current\)\) return;\s*setToolPresetState\(getPreferredToolPreset\(\)\)/,
  );
  assert.match(source, /d\.toolNames !== undefined \? getPresetFromToolNames\(d\.toolNames\) : "default"/);
  assert.match(changeSource, /setPreferredToolPreset\(preset\)/);
  assert.match(changeSource, /\(sid, \{ type: "set_tools", toolNames \}\)/);
  assert.match(changeSource, /replaceSessionId\(activeSessionId\)/);
  assert.doesNotMatch(changeSource, /sessionIdRef\.current = activeSessionId/);
  assert.doesNotMatch(loadToolsSource, /setPreferredToolPreset/);
});

test("existing-session prompts rely on the persisted tool selection", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );
  const existingSessionPrompt = sendSource.slice(sendSource.indexOf("} else if (session)"));

  assert.match(existingSessionPrompt, /type: "prompt",\s*message,/);
  assert.doesNotMatch(existingSessionPrompt, /toolNames:/);
  assert.doesNotMatch(sendSource, /restoreSubmission, toolPreset\]\);/);
});

test("submission recovery updates live refs before a possible session rekey", () => {
  const restoreMethod = chatInputSource.slice(
    chatInputSource.indexOf("    restoreSubmission(text:"),
    chatInputSource.indexOf("    insertText(text:"),
  );

  assert.ok(
    restoreMethod.indexOf("valueRef.current = restoredDraft.value")
      < restoreMethod.indexOf("setValue((current) =>"),
  );
  assert.ok(
    restoreMethod.indexOf("attachedImagesRef.current = restoredImages")
      < restoreMethod.indexOf("setAttachedImages((current) =>"),
  );
});

test("stale fresh-session completion cannot replace the active composer", () => {
  const cwdChangeSource = appShellSource.slice(
    appShellSource.indexOf("  const handleCwdChange = useCallback"),
    appShellSource.indexOf("  const handleSelectSession = useCallback"),
  );
  const newSessionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleNewSession = useCallback"),
    appShellSource.indexOf("  // Global keyboard shortcuts"),
  );
  const createdSource = appShellSource.slice(
    appShellSource.indexOf("  const handleSessionCreated = useCallback"),
    appShellSource.indexOf("  const handleAgentEnd = useCallback"),
  );

  assert.match(newSessionSource, /const draftKey = `new:\$\{sessionId\}:\$\{cwd\}`/);
  assert.match(newSessionSource, /activeNewSessionDraftKeyRef\.current = draftKey/);
  assert.match(createdSource, /activeNewSessionDraftKeyRef\.current !== sourceDraftKey/);
  assert.match(cwdChangeSource, /const currentFreshCwd = newSessionCwd \?\? activeCwd/);
  assert.match(
    cwdChangeSource,
    /currentProject === newProject\s*&& \(selectedSession !== null \|\| currentFreshCwd === cwd\)/,
  );
  assert.match(cwdChangeSource, /if \(currentProject !== newProject\) \{[\s\S]*?setFileTabs\(\[\]\)/);
  assert.match(
    appShellSource,
    /useLayoutEffect\(\(\) => \{\s*activeNewSessionDraftKeyRef\.current = newSessionDraftKey;/,
  );
  assert.ok(
    createdSource.indexOf("activeNewSessionDraftKeyRef.current !== sourceDraftKey")
      < createdSource.indexOf("setSelectedSession(session)"),
  );
});

test("abandoned fresh-session drafts are cleared and cannot be recreated by late rejection", () => {
  const restoreSource = source.slice(
    source.indexOf("  const restoreSubmission = useCallback"),
    source.indexOf("  const sessionStats = useMemo"),
  );
  const mountSource = source.slice(
    source.indexOf("  // Load session on mount"),
    source.indexOf("  useEffect(() => {\n    onSystemPromptChange"),
  );

  assert.match(restoreSource, /!sessionHookMountedRef\.current[\s\S]*?!newSessionPromotedRef\.current/);
  assert.match(mountSource, /const abandonedDraftKey = isNew \? newSessionDraftKey : null/);
  assert.match(mountSource, /clearDraft\(abandonedDraftKey\)/);
});

test("streaming submissions cannot be stranded in an idle direct queue", () => {
  const queueSource = source.slice(
    source.indexOf("  // Let AgentSession.prompt decide atomically"),
    source.indexOf("  const handleAbortCompaction"),
  );

  assert.match(queueSource, /type: "prompt"/);
  assert.match(queueSource, /streamingBehavior: behavior/);
  assert.match(queueSource, /if \(isPromptRejectedError\(e\)\) restore\(\)/);
  assert.doesNotMatch(queueSource, /type: "steer"/);
  assert.doesNotMatch(queueSource, /type: "follow_up"/);
});

test("built-in clone switches to the independent child session", () => {
  const builtinSource = source.slice(
    source.indexOf("  const handleBuiltinSlashCommand"),
    source.indexOf("  // Let AgentSession.prompt decide atomically"),
  );

  assert.match(builtinSource, /case "clone"/);
  assert.match(builtinSource, /type: "clone",\s+leafId: activeLeafId/);
  assert.match(builtinSource, /agentRunningRef\.current \|\| bashRunningRef\.current/);
  assert.match(builtinSource, /onSessionForked\?\.\(result\.newSessionId\)/);
});

test("post-accept prompt errors do not duplicate the user submission", () => {
  const promptErrorSource = source.slice(
    source.indexOf('case "prompt_error"'),
    source.indexOf('case "extension_error"'),
  );

  assert.match(promptErrorSource, /addNotice/);
  assert.doesNotMatch(promptErrorSource, /restoreSubmission/);
});

test("delegates event stream readiness and hides an empty agent phase", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureEventsConnected"),
    source.indexOf("const respondToExtensionUi"),
  );

  assert.match(source, /new AgentEventConnection\(\{/);
  assert.match(source, /shouldMaintain: \(sid\)[\s\S]*?sessionIdRef\.current === sid/);
  assert.match(ensureSource, /eventConnectionRef\.current!\.ensureConnected\(sid\)/);
  assert.match(ensureSource, /eventConnectionRef\.current!\.maintain\(sid\)/);
  assert.match(chatWindowSource, /const hasStreamingContent = Boolean\(streamState\.streamingMessage\?\.content\.length\)/);
  assert.match(chatWindowSource, /streamState\.isStreaming && hasStreamingContent && streamState\.streamingMessage/);
  assert.match(chatWindowSource, /agentRunning && !hasStreamingContent && agentPhase/);
  assert.match(chatWindowSource, /return null;/);
});

test("uses one absolute agent-readiness deadline instead of a five-second transport deadline", () => {
  assert.match(source, /EVENT_STREAM_READY_TIMEOUT_MS = 60_000/);
  assert.doesNotMatch(source, /EVENT_STREAM_OPEN_TIMEOUT_MS/);
});

test("uses server pagination state instead of guessing from rendered rows", () => {
  const loadContextSource = source.slice(
    source.indexOf("const loadContext = useCallback"),
    source.indexOf("const loadTools = useCallback"),
  );
  assert.match(source, /const \[hasEarlierMessages, setHasEarlierMessages\] = useState\(false\)/);
  assert.match(source, /setHasEarlierMessages\(d\.context\.hasMore\)/);
  assert.match(source, /setHistoryCursor\(d\.context\.oldestEntryId\)/);
  assert.match(loadContextSource, /setData\(\(prev\) => \{[\s\S]*messages: \[\.\.\.newPageMessages, \.\.\.prev\.context\.messages\]/);
  assert.match(loadContextSource, /newIndexes = before/);
  assert.match(loadContextSource, /entryIdsRef\.current\.includes\(id\)/);
  assert.match(chatWindowSource, /const oldestId = historyCursor/);
  assert.doesNotMatch(chatWindowSource, /const oldestId = entryIds\[0\]/);
  assert.match(chatWindowSource, /if \(!hasEarlierMessages\) return/);
  assert.match(chatWindowSource, /const hasMore = startIndex > 0 \|\| hasEarlierMessages/);
  assert.doesNotMatch(chatWindowSource, /rendered\.length >= visibleCount/);
});

test("runs the external observer lifecycle through demand, reconnect, append, and replacement", async () => {
  await withHookRuntime(async ({ make, FakeEventSource, flush }) => {
    const initial = { role: "assistant", content: [{ type: "text", text: "initial" }], timestamp: 1 }, remote = { role: "assistant", content: [{ type: "text", text: "remote" }], timestamp: 2 }, json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const sessionData = (messages = [initial], ids = ["e1"], leafId = ids.at(-1)) => ({ sessionId: "session-a", filePath: "/tmp/session-a", totalActiveMs: 0, tree: [], leafId, context: { messages, entryIds: ids, oldestEntryId: ids[0] ?? null, hasMore: false, thinkingLevel: "auto", model: null } });
    let sessionLoads = 0, currentSessionData = sessionData(), holdNextLoad = false, resolveHeldLoad;
    const observerFetch = async (url) => {
      const path = new URL(String(url), "http://localhost").pathname;
      if (path === "/api/models") return json({ models: {}, modelList: [] });
      if (path === "/api/sessions/session-a/state") return json({ running: true, readOnly: true });
      if (path === "/api/sessions/session-a") { sessionLoads += 1; if (holdNextLoad) { holdNextLoad = false; return new Promise((resolve) => { resolveHeldLoad = resolve; }); } return json(currentSessionData); }
      return json({ running: false });
    };
    const observer = make({ session: { id: "session-a", cwd: "/tmp" }, sessionRunning: false, newSessionCwd: null, newSessionDraftKey: null }, observerFetch);
    let view = observer.useHook(); await flush(); view = observer.useHook();
    assert.equal(FakeEventSource.sources.length, 1, "readOnly state must create demand without running-list timing"); assert.equal(sessionLoads, 1);
    FakeEventSource.sources[0].message({ type: "connected", sessionId: "session-a", isStreaming: false }); await flush(); assert.equal(sessionLoads, 2, "plain observer connected must reconcile the current session");
    const appendEvent = { type: "message_end", sessionId: "session-a", entryId: "e2", message: remote };
    view.handleAgentEventRef.current(appendEvent); view.handleAgentEventRef.current(appendEvent); currentSessionData = sessionData([initial, remote], ["e1", "e2"], "e2"); view = observer.useHook(); assert.deepEqual([view.messages.length, view.entryIds, view.data.leafId, view.activeLeafId], [2, ["e1", "e2"], "e2", "e2"]);
    FakeEventSource.sources[0].error(); await flush(); await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(FakeEventSource.sources.length, 2, "observer demand must reconnect after a transient error");
    FakeEventSource.sources[1].message({ type: "connected", sessionId: "session-a", isStreaming: false }); await flush(); assert.equal(sessionLoads, 3, "reconnect must reconcile the current session");
    holdNextLoad = true; view.handleAgentEventRef.current({ type: "connected", sessionId: "session-a", isStreaming: false }); await flush(); view.sessionIdRef.current = "session-b";
    resolveHeldLoad(json(sessionData([{ role: "assistant", content: [{ type: "text", text: "old" }] }], ["old"], "old"))); await flush(); view = observer.useHook(); FakeEventSource.sources[0].message({ type: "message_end", sessionId: "session-a", entryId: "e3", message: remote }); view.handleAgentEventRef.current({ type: "message_end", sessionId: "session-a", entryId: "e3", message: remote }); view = observer.useHook();
    assert.deepEqual([view.messages.length, view.data.leafId, view.activeLeafId, FakeEventSource.sources.length], [2, "e2", "e2", 2], "old-session event/load must not update a replacement"); observer.unmount();

    let writableLoads = 0;
    const writableFetch = async (url) => {
      const path = new URL(String(url), "http://localhost").pathname;
      if (path === "/api/models") return json({ models: {}, modelList: [] });
      if (path === "/api/sessions/session-a") { writableLoads += 1; return json(sessionData()); }
      if (path === "/api/sessions/session-a/state") return json({ running: true, state: { isStreaming: true } });
      if (path === "/api/agent/session-a") return json({ running: false });
      return json({ success: true, data: [] });
    };
    const writable = make({ session: { id: "session-a", cwd: "/tmp" }, sessionRunning: true, newSessionCwd: null, newSessionDraftKey: null }, writableFetch);
    view = writable.useHook(); await flush(); view = writable.useHook(); const sourceBeforeConnected = writableLoads, writableSource = FakeEventSource.sources[0];
    writableSource.message({ type: "connected", sessionId: "session-a", isStreaming: true }); await flush(); assert.equal(writableLoads, sourceBeforeConnected, "writable connected must not use observer reconciliation");
    view = writable.useHook(); assert.equal(view.agentRunning, true); view.handleAgentEventRef.current({ type: "agent_settled" }); await flush(); await new Promise((resolve) => setTimeout(resolve, 0)); view = writable.useHook();
    assert.deepEqual([view.agentRunning, writableSource.closeCount], [false, 1], "normal writable idle completion must close its stream"); writable.unmount();
  });
});


test("keeps one reducer-owned assistant partial and consumes Pi JSON deltas", () => {
  const connectedSource = source.slice(
    source.indexOf('case "connected"'),
    source.indexOf('case "agent_start"'),
  );
  const streamSource = source.slice(
    source.indexOf('case "message_start"'),
    source.indexOf('case "message_end"'),
  );
  const messageEndSource = source.slice(
    source.indexOf('case "message_end"'),
    source.indexOf('case "tool_execution_start"'),
  );

  assert.match(source, /streamReducer,[\s\S]*type ClientAssistantMessageEvent/);
  assert.doesNotMatch(source, /streamingMessageRef/);
  assert.match(connectedSource, /dispatch\(\{ type: "end" \}\)/);
  assert.match(connectedSource, /event\.isStreaming === true/);
  assert.match(connectedSource, /agentRunningRef\.current = true/);
  assert.match(streamSource, /msg\?\.role === "assistant"[\s\S]*dispatch\(\{ type: "snapshot", message: msg \}\)/);
  assert.match(streamSource, /event\.assistantMessageEvent as ClientAssistantMessageEvent/);
  assert.match(streamSource, /dispatch\(\{ type: "delta", event: delta \}\)/);
  assert.match(streamSource, /delta\.type !== "toolcall_start" && delta\.type !== "toolcall_delta"/);
  assert.doesNotMatch(streamSource, /case "message_delta"/);
  assert.match(messageEndSource, /const completed = event\.message as AgentMessage/);
  assert.match(messageEndSource, /normalizeToolCalls\(completed\)/);
  assert.match(messageEndSource, /dispatch\(\{ type: "end" \}\)/);
  assert.doesNotMatch(messageEndSource, /streamState\.streamingMessage/);
});

test("shows the latest streamed tool execution progress in the running phase", () => {
  const updateSource = source.slice(
    source.indexOf('case "tool_execution_update"'),
    source.indexOf('case "tool_execution_end"'),
  );

  assert.match(updateSource, /getToolExecutionProgress\(event\.partialResult\)/);
  assert.match(updateSource, /tools: \[\.\.\.tools\.filter\([\s\S]*?, updated\]/);
  assert.match(chatWindowSource, /if \(latest\?\.progress\)/);
  assert.match(chatWindowSource, /chat\.runningNamedTool[\s\S]*latest\.progress/);
});

test("plays the enabled sound once for each extension dialog", () => {
  assert.match(chatWindowSource, /soundedExtensionDialogIdRef = useRef<string \| null>\(null\)/);
  assert.match(
    chatWindowSource,
    /soundedExtensionDialogIdRef\.current === extensionDialog\.id/,
  );
  assert.match(chatWindowSource, /soundedExtensionDialogIdRef\.current = extensionDialog\.id/);
  assert.match(chatWindowSource, /playDoneSoundRef\.current\(\)/);
});

test("suppresses sounds and browser attention for the active subagent session", () => {
  const completionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAgentEnd = useCallback"),
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
  );
  const attentionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
    appShellSource.indexOf("  const handleAutoName = useCallback"),
  );

  assert.match(chatWindowSource, /completionNotificationsEnabled = session\?\.relation\?\.kind !== "subagent"/);
  assert.match(chatWindowSource, /completionNotificationsEnabled && soundEnabledRef\.current/);
  assert.match(chatWindowSource, /!completionNotificationsEnabled[\s\S]*?!extensionDialog/);
  assert.match(completionSource, /selectedSession\?\.relation\?\.kind === "subagent"\) return/);
  assert.match(attentionSource, /selectedSession\?\.relation\?\.kind === "subagent"\) return/);
});

test("routes blocking extension requests through deduplicated browser attention notifications", () => {
  const completionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAgentEnd = useCallback"),
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
  );
  const extensionRequestSource = source.slice(
    source.indexOf("  const handleExtensionUiRequest = useCallback"),
    source.indexOf("  const settleUiStage = useCallback"),
  );
  const attentionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
    appShellSource.indexOf("  const handleAutoName = useCallback"),
  );

  assert.match(
    extensionRequestSource,
    /isBlockingExtensionUiRequest\(request\)[\s\S]*?onAttentionNeeded\?\.\(request\)/,
  );
  assert.match(chatWindowSource, /onAttentionNeeded, onSessionCreated/);
  assert.match(completionSource, /if \(!shouldShowBrowserNotification\(\)\) return/);
  assert.doesNotMatch(completionSource, /pushActive/);
  assert.match(completionSource, /tag: targetSession \? `pi-session-complete:\$\{targetSession\.id\}`/);
  assert.doesNotMatch(completionSource, /document\.visibilityState === "visible"/);
  assert.match(attentionSource, /shouldShowBrowserNotification\(\)/);
  assert.match(attentionSource, /claimExtensionAttentionNotification\(request, notifiedAttentionRequestIdsRef\.current\)/);
  assert.match(attentionSource, /tag: `pi-extension-ui:\$\{request\.id\}`/);
  assert.match(appShellSource, /onAttentionNeeded=\{handleAttentionNeeded\}/);
});

test("keeps live following cancellable when the user scrolls away from the tail", () => {
  const streamUpdateSource = source.slice(
    source.indexOf('case "message_start"'),
    source.indexOf('case "message_end"'),
  );
  const scrollHandlerSource = source.slice(
    source.indexOf("const handleScrollPositionChange"),
    source.indexOf("// Load session on mount"),
  );
  const scrollToBottomSource = source.slice(
    source.indexOf("const scrollToBottom"),
    source.indexOf("const currentModel"),
  );

  assert.match(source, /const liveFollowFrameRef = useRef<number \| null>\(null\)/);
  assert.match(source, /const previousScrollTopRef = useRef\(0\)/);
  assert.match(source, /const wasAttached = isNearBottomRef\.current;[\s\S]*?const isAttached = getLiveFollowAttached\([\s\S]*?wasAttached,[\s\S]*?previousScrollTopRef\.current,[\s\S]*?scrollTop,[\s\S]*?clientHeight,[\s\S]*?scrollHeight/);
  assert.match(scrollHandlerSource, /const isAgentRunning = agentRunningRef\.current;[\s\S]*?isAgentRunning\s*\? CHAT_SCROLL_REATTACH_TOLERANCE\s*:\s*CHAT_SCROLL_TAIL_TOLERANCE/);
  assert.match(source, /previousScrollTopRef\.current = scrollTop/);
  assert.match(scrollToBottomSource, /const container = scrollContainerRef\.current;\s*if \(!container\) return;/);
  assert.match(scrollToBottomSource, /container\.scrollTo\(\{ top: container\.scrollHeight, behavior \}\);\s*previousScrollTopRef\.current = container\.scrollTop;/);
  assert.doesNotMatch(scrollToBottomSource, /scrollIntoView/);
  assert.match(streamUpdateSource, /liveFollowFrameRef\.current === null/);
  assert.match(streamUpdateSource, /requestAnimationFrame\(\(\) => \{[\s\S]*?liveFollowFrameRef\.current = null;[\s\S]*?if \(isNearBottomRef\.current\) scrollToBottom\("auto"\)/);
  assert.match(scrollHandlerSource, /!wasAttached && isAttached && isAgentRunning[\s\S]*?scrollToBottom\("auto"\)/);
  assert.match(scrollHandlerSource, /cancelAnimationFrame\(liveFollowFrameRef\.current\)/);
  assert.match(source, /previousScrollTopRef\.current = container\.scrollTop;\s*container\.addEventListener\("scroll", handleScrollPositionChange/);
  assert.doesNotMatch(source, /SCROLL_BOTTOM_THRESHOLD|completionScrollAllowedRef|ignoreProgrammaticScrollUntilRef/);
});

test("restores an in-page session viewport without the default tail jump", () => {
  assert.match(source, /const initialScrollDoneRef = useRef\(Boolean\(opts\.deferInitialScroll\)\)/);
  assert.match(source, /const scrollToMessage = useCallback\(\(element: HTMLElement, viewportOffset = 16\)/);
  assert.match(source, /container\.scrollTop\s+- viewportOffset/);
  assert.match(chatWindowSource, /deferInitialScroll: Boolean\(pendingScrollRestore\)/);
  assert.match(chatWindowSource, /isScrollAtTail\(container\.scrollTop, container\.clientHeight, container\.scrollHeight\)/);
  assert.match(chatWindowSource, /findChatScrollAnchor\(/);
  assert.match(chatWindowSource, /while \(hasMore && before && !controller\.signal\.aborted\)/);
  assert.match(chatWindowSource, /context\.oldestEntryId === position\.oldestEntryId/);
  assert.match(chatWindowSource, /if \(!context\) \{\s*scrollToBottom\("instant"\);\s*setPendingScrollRestore\(null\);/);
  assert.match(chatWindowSource, /scrollToMessage\(element, position\.anchorOffset\)/);
  assert.match(chatWindowSource, /visibility: pendingScrollRestore \? "hidden" : undefined/);
});

test("keeps a newly sent user message at the top while its response starts", () => {
  const streamUpdateSource = source.slice(
    source.indexOf('case "message_start"'),
    source.indexOf('case "message_end"'),
  );
  const userScrollSource = source.slice(
    source.indexOf("const scrollUserMsgToTop"),
    source.indexOf("const handleScrollPositionChange"),
  );
  const scrollEffectSource = source.slice(
    source.indexOf("useLayoutEffect(() => {\n    if (messages.length > 0)"),
    source.indexOf("// Load model list"),
  );

  assert.match(streamUpdateSource, /!pendingScrollToUserRef\.current && isNearBottomRef\.current/);
  assert.match(source, /const \[promptAnchorActive, setPromptAnchorActive\] = useState\(false\)/);
  assert.match(source, /pendingScrollToUserRef\.current = true;\s*setPromptAnchorActive\(true\)/);
  assert.match(userScrollSource, /const targetTop = Math\.min\(Math\.max\(0, elAbsTop - 16\), maxScrollTop\)/);
  assert.match(userScrollSource, /cancelAnimationFrame\(liveFollowFrameRef\.current\)/);
  assert.match(userScrollSource, /isNearBottomRef\.current = true/);
  assert.match(userScrollSource, /previousScrollTopRef\.current = targetTop/);
  assert.match(userScrollSource, /container\.scrollTo\(\{ top: targetTop, behavior: "auto" \}\)/);
  assert.match(scrollEffectSource, /pendingScrollToUserRef\.current = false;[\s\S]*?scrollUserMsgToTop\(\)/);
  assert.match(chatWindowSource, /const contentEnd = spacer\.getBoundingClientRect\(\)\.top[\s\S]*?getPromptAnchorSpacerHeight\([\s\S]*?targetTop,[\s\S]*?contentEnd,[\s\S]*?container\.clientHeight/);
  assert.match(chatWindowSource, /<div ref=\{promptAnchorSpacerRef\} aria-hidden="true" \/>/);
  assert.match(chatWindowSource, /const promptAnchorAdjustmentDoneRef = useRef\(false\)/);
  assert.match(chatWindowSource, /promptAnchorAdjustmentDoneRef\.current = false/);
  assert.match(chatWindowSource, /const isInitialMeasurement = !promptAnchorAdjustmentDoneRef\.current;[\s\S]*?promptAnchorAdjustmentDoneRef\.current = true;[\s\S]*?if \(needsInitialAdjustment\) scrollUserMsgToTop\(\)/);
});

test("keeps prompt anchor measurement outside the React update cycle", () => {
  const anchorEffectStart = chatWindowSource.indexOf(
    "useLayoutEffect(() => {\n    const spacer = promptAnchorSpacerRef.current;",
  );
  assert.notEqual(anchorEffectStart, -1);
  const syncEffectStart = chatWindowSource.indexOf(
    "useLayoutEffect(() => {\n    promptAnchorUpdateRef.current?.();",
    anchorEffectStart,
  );
  assert.notEqual(syncEffectStart, -1);
  const anchorLifecycleEffectSource = chatWindowSource.slice(
    anchorEffectStart,
    syncEffectStart,
  );
  const anchorSyncEffectSource = chatWindowSource.slice(
    syncEffectStart,
    chatWindowSource.indexOf("const availableThinkingLevels"),
  );

  assert.doesNotMatch(anchorLifecycleEffectSource, /\bset[A-Z][A-Za-z0-9]*\s*\(/);
  assert.doesNotMatch(anchorSyncEffectSource, /\bset[A-Z][A-Za-z0-9]*\s*\(/);
  assert.doesNotMatch(chatWindowSource, /setPromptAnchorSpacer|useState[^\n]*promptAnchorSpacer/);
  assert.doesNotMatch(anchorLifecycleEffectSource, /streamState\.streamingMessage/);
  assert.match(anchorLifecycleEffectSource, /spacer\.style\.height = nextPromptAnchorSpacerHeight > 0/);
  assert.match(anchorLifecycleEffectSource, /promptAnchorUpdateRef\.current = updatePromptAnchorSpacer/);
  assert.match(anchorLifecycleEffectSource, /new ResizeObserver\(schedulePromptAnchorMeasure\)/);
  assert.match(anchorLifecycleEffectSource, /observer\?\.observe\(messageContent\)/);
  assert.match(anchorLifecycleEffectSource, /if \(disposed \|\| promptAnchorMeasureFrameRef\.current !== null\) return/);
  assert.match(anchorLifecycleEffectSource, /promptAnchorMeasureFrameRef\.current = requestAnimationFrame\(\(\) => \{\s*promptAnchorMeasureFrameRef\.current = null;\s*updatePromptAnchorSpacer\(\)/);
  assert.match(anchorLifecycleEffectSource, /disposed = true;[\s\S]*?promptAnchorUpdateRef\.current === updatePromptAnchorSpacer[\s\S]*?cancelAnimationFrame\(promptAnchorMeasureFrameRef\.current\)/);
  assert.match(anchorSyncEffectSource, /promptAnchorUpdateRef\.current\?\.\(\);\s*\}, \[streamState\.streamingMessage\]\)/);
  assert.match(chatWindowSource, /<div ref=\{messageContentRef\}[^>]*style=\{\{/);
});

test("uses the prompt anchor as the only trailing message spacer", () => {
  assert.match(chatWindowSource, /<div ref=\{promptAnchorSpacerRef\} aria-hidden="true" \/>[\s\S]*?<\/div>/);
  assert.doesNotMatch(chatWindowSource, /bottomComposer(?:Ref|Height|ScrollFrameRef)/);
  assert.doesNotMatch(chatWindowSource, /new ResizeObserver\(updateBottomComposerHeight\)/);
});

test("keeps a detached viewport in place when streaming completes", () => {
  const scrollEffectSource = source.slice(
    source.indexOf("useLayoutEffect(() => {\n    if (messages.length > 0)"),
    source.indexOf("// Load model list"),
  );

  assert.match(scrollEffectSource, /!agentRunningRef\.current && isNearBottomRef\.current[\s\S]*?scrollToBottom\("auto"\)/);
  assert.doesNotMatch(scrollEffectSource, /\|\|/);
  assert.match(source, /addEventListener\("scroll", handleScrollPositionChange/);
});

test("agent_end state fetch cannot update a replaced session", () => {
  const agentEndSource = source.slice(
    source.indexOf('case "agent_end"'),
    source.indexOf('case "agent_settled"'),
  );

  assert.match(agentEndSource, /const endedSessionId = sessionIdRef\.current/);
  assert.match(agentEndSource, /sessionIdRef\.current !== endedSessionId\) return;/);
  assert.match(agentEndSource, /loadSession\(endedSessionId\)/);
  assert.doesNotMatch(agentEndSource, /sessionIdRef\.current\)\s*\.then/);
});

test("loadSession error and 404 paths cannot update a replaced session", () => {
  const loadSessionSource = source.slice(
    source.indexOf("  const loadSession = useCallback"),
    source.indexOf("  const loadContext = useCallback"),
  );

  assert.match(loadSessionSource, /if \(res\.status === 404\) \{\s*if \(sessionIdRef\.current !== sid\) return null;/);
  assert.match(loadSessionSource, /\} catch \(e\) \{\s*if \(sessionIdRef\.current !== sid\) return null;[\s\S]*?if \(paginationGenerationRef\.current !== generation\) return null;[\s\S]*?setError\(String\(e\)\)/);
  assert.match(loadSessionSource, /if \(sessionHookMountedRef\.current && !messagesLoaded && sessionIdRef\.current === sid && loadingTokenRef\.current === loadingToken && paginationGenerationRef\.current === generation\) setLoading\(false\)/);
});

test("existing-session Send and Stop share the hook-local runtime owner", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );
  const abortSource = source.slice(
    source.indexOf("  const handleAbort = useCallback"),
    source.indexOf("  const handleFork = useCallback"),
  );
  const existingSessionPrompt = sendSource.slice(sendSource.indexOf("} else if (session)"));

  assert.match(existingSessionPrompt, /const sid = sessionIdRef\.current/);
  assert.match(existingSessionPrompt, /sentSessionId = sid/);
  assert.match(existingSessionPrompt, /ensureEventsConnected\(sid\)/);
  assert.match(existingSessionPrompt, /sendAgentCommand\(sid, \{\s*type: "prompt"/);
  assert.doesNotMatch(existingSessionPrompt, /session\.id/);
  assert.match(abortSource, /const sid = sessionIdRef\.current/);
  assert.match(abortSource, /sendAgentCommand\(sid, \{ type: "abort" \}\)/);
  assert.match(source, /const eventConnectionRef = useRef<AgentEventConnection \| null>\(null\)/);
  assert.match(source, /const \[queuedMessages, setQueuedMessages\]/);
  assert.match(source, /const draftKeyAliasesRef = useRef\(new Map<string, string>\(\)\)/);
});

test("stale pagination responses cannot commit after a leaf switch or superseding request", () => {
  const loadContextSource = source.slice(
    source.indexOf("const loadContext = useCallback"),
    source.indexOf("const loadTools = useCallback"),
  );
  const loadSessionSource = source.slice(
    source.indexOf("  const loadSession = useCallback"),
    source.indexOf("  const loadContext = useCallback"),
  );
  const snapshotSource = source.slice(
    source.indexOf('case "session_snapshot"'),
    source.indexOf('case "agent_start"'),
  );

  // Every pagination request captures a generation; only the latest
  // generation may commit messages, entryIds, cursor, or hasMore.
  assert.match(source, /const paginationGenerationRef = useRef\(0\)/);
  assert.match(loadContextSource, /const generation = \+\+paginationGenerationRef\.current/);
  assert.match(loadContextSource, /paginationGenerationRef\.current !== generation\) return;/);
  // The generation guard sits before the anchor check and every state write.
  assert.ok(
    loadContextSource.indexOf("paginationGenerationRef.current !== generation) return;")
      < loadContextSource.indexOf("setHistoryCursor(d.context.oldestEntryId)"),
  );
  // A fresh full transcript (loadSession or observer snapshot) supersedes any
  // in-flight pagination page for the previous leaf. loadSession captures a
  // generation at start and only the latest generation may commit.
  assert.match(loadSessionSource, /const generation = \+\+paginationGenerationRef\.current;/);
  assert.match(loadSessionSource, /paginationGenerationRef\.current !== generation\) return null;/);
  assert.match(snapshotSource, /paginationGenerationRef\.current \+= 1;/);
  // The 404 reset also replaces the transcript wholesale: it must check the
  // generation before clearing messages, entryIds, cursor, hasMore.
  const notFoundSource = loadSessionSource.slice(
    loadSessionSource.indexOf("res.status === 404"),
    loadSessionSource.indexOf("if (!res.ok) throw new Error"),
  );
  assert.match(notFoundSource, /paginationGenerationRef\.current !== generation\) return null;/);
  assert.ok(
    notFoundSource.indexOf("paginationGenerationRef.current !== generation) return null;")
      < notFoundSource.indexOf("setMessages([])"),
  );
  // A superseded loadSession must not commit an error or clear the loading
  // indicator either.
  const errorPathSource = loadSessionSource.slice(
    loadSessionSource.indexOf("} catch (e) {"),
    loadSessionSource.indexOf("}, [setToolPresetState, applyEntryIds]);"),
  );
  assert.match(errorPathSource, /paginationGenerationRef\.current !== generation\) return null;/);
  assert.match(errorPathSource, /loadingTokenRef\.current === loadingToken && paginationGenerationRef\.current === generation\) setLoading\(false\);/);
  // Entry-id dedup is preserved.
  assert.match(loadContextSource, /entryIdsRef\.current\.includes\(id\)/);
});

test("loading ownership transfers to every superseding operation", () => {
  const loadSessionSource = source.slice(
    source.indexOf("  const loadSession = useCallback"),
    source.indexOf("  const loadContext = useCallback"),
  );
  const loadContextSource = source.slice(
    source.indexOf("const loadContext = useCallback"),
    source.indexOf("const loadTools = useCallback"),
  );
  const snapshotSource = source.slice(
    source.indexOf('case "session_snapshot"'),
    source.indexOf('case "agent_start"'),
  );

  // Every full load takes loading ownership (a non-loading load superseding a
  // loading one must clear the indicator when it settles); only showLoading
  // requests show it.
  assert.match(source, /const loadingTokenRef = useRef\(0\)/);
  assert.match(loadSessionSource, /const loadingToken = \+\+loadingTokenRef\.current;/);
  assert.match(loadSessionSource, /if \(showLoading\) setLoading\(true\);/);
  // The success path and the finally both clear only while the request still
  // owns the token and the hook is mounted; the finally additionally requires
  // the request to still be the newest operation, so an obsolete owner's
  // cleanup cannot hide the indicator while a newer operation is in flight.
  assert.match(loadSessionSource, /if \(sessionHookMountedRef\.current && loadingTokenRef\.current === loadingToken\) setLoading\(false\);/);
  assert.match(loadSessionSource, /if \(sessionHookMountedRef\.current && !messagesLoaded && sessionIdRef\.current === sid && loadingTokenRef\.current === loadingToken && paginationGenerationRef\.current === generation\) setLoading\(false\);/);
  // Pagination takes over loading ownership and clears on every terminal path
  // (commit, abort, stale anchor, error), so a superseded full load can never
  // strand loading.
  assert.match(loadContextSource, /const loadingToken = \+\+loadingTokenRef\.current;/);
  assert.match(loadContextSource, /const clearLoadingIfOwned = \(\) => \{[\s\S]*?sessionHookMountedRef\.current && sessionIdRef\.current === sid && loadingTokenRef\.current === loadingToken\) setLoading\(false\);/);
  assert.match(loadContextSource, /clearLoadingIfOwned\(\);/);
  // An observer snapshot takes over loading ownership and clears it: the
  // transcript is committed synchronously.
  assert.match(snapshotSource, /const loadingToken = \+\+loadingTokenRef\.current;/);
  assert.match(snapshotSource, /setLoading\(false\);/);
});

test("direct session replacement invalidates loading ownership before the id changes", () => {
  const helperSource = source.slice(
    source.indexOf("  const replaceSessionId = useCallback"),
    source.indexOf("  const applyEntryIds = useCallback"),
  );
  const ensureSource = source.slice(
    source.indexOf("  const ensureNewSession = useCallback"),
    source.indexOf("  // Opening the System or Tools panel"),
  );
  const presetSource = source.slice(
    source.indexOf("  const handleToolPresetChange = useCallback"),
    source.indexOf("  const scrollUserMsgToTop"),
  );

  // The helper invalidates loading ownership and clears the indicator while
  // mounted before the identity changes, so an in-flight old-session request
  // (session-guarded) can neither clear the replacement's loading nor leave
  // a stuck indicator when no new request starts.
  assert.match(helperSource, /loadingTokenRef\.current \+= 1;/);
  assert.match(helperSource, /if \(sessionHookMountedRef\.current\) setLoading\(false\);/);
  assert.match(helperSource, /sessionIdRef\.current = nextId;/);
  // Tool-preset recreation and new-session promotion (the ensure_session
  // identity assignment) route through the helper.
  assert.match(presetSource, /replaceSessionId\(activeSessionId\)/);
  assert.match(ensureSource, /replaceSessionId\(realId\)/);
  assert.doesNotMatch(ensureSource, /sessionIdRef\.current = realId/);
});

test("a queued observer snapshot after unmount cannot clear loading", () => {
  const snapshotSource = source.slice(
    source.indexOf('case "session_snapshot"'),
    source.indexOf('case "agent_start"'),
  );

  // The snapshot takes loading ownership and clears it only while the hook
  // is still mounted and still owns the token: a queued EventSource event
  // delivered after cleanup cannot call setLoading(false).
  assert.match(snapshotSource, /const loadingToken = \+\+loadingTokenRef\.current;/);
  assert.match(
    snapshotSource,
    /if \(sessionHookMountedRef\.current && loadingTokenRef\.current === loadingToken\) setLoading\(false\);/,
  );
});

test("an accepted 404 clears stale transcript state for every caller", () => {
  const loadSessionSource = source.slice(
    source.indexOf("  const loadSession = useCallback"),
    source.indexOf("  const loadContext = useCallback"),
  );
  const notFoundSource = loadSessionSource.slice(
    loadSessionSource.indexOf("res.status === 404"),
    loadSessionSource.indexOf("if (!res.ok) throw new Error"),
  );

  // The reset is unconditional: it must not depend on showLoading, because
  // non-loading reconciliation callers (default showLoading=false) also need
  // a deleted/missing session to clear stale data, messages, entry ids,
  // cursor, hasMore, and error.
  assert.doesNotMatch(notFoundSource, /if \(showLoading\)/);
  assert.match(
    notFoundSource,
    /setData\(null\)[\s\S]*?setActiveLeafId\(null\)[\s\S]*?setMessages\(\[\]\)[\s\S]*?applyEntryIds\(\[\]\)[\s\S]*?setHistoryCursor\(null\)[\s\S]*?setHasEarlierMessages\(false\)[\s\S]*?setError\(null\)/,
  );
  // A stale 404 (superseded by a newer full load or pagination request) must
  // not clear the newer state: the generation guard precedes every clear.
  assert.ok(
    notFoundSource.indexOf("paginationGenerationRef.current !== generation) return null;")
      < notFoundSource.indexOf("setData(null)"),
  );
  // Loading UI stays governed by the loading token only: the 404 path itself
  // never touches loading.
  assert.doesNotMatch(notFoundSource, /setLoading/);
});
