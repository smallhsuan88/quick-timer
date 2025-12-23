(function () {
  const STORAGE_KEYS = {
    mode: "qt.mode",
    sequenceConfig: "qt.sequenceConfig",
    sequenceRuntime: "qt.sequenceRuntime",
  };

  const SOUND_FILES = {
    remind: "audio/smb_warning.mp3",
    end: "audio/smb_mariodie.mp3",
  };

  const SEQUENCE_TEMPLATES = {
    pomodoro: {
      name: "番茄鐘",
      cycles: 4,
      autoStartNext: true,
      autoStartNextCycle: true,
      endBehavior: "stop",
      steps: [
        { label: "工作", durationSec: 25 * 60, type: "work" },
        { label: "休息", durationSec: 5 * 60, type: "rest" },
      ],
    },
    cooking: {
      name: "煮飯示例",
      cycles: 1,
      autoStartNext: true,
      autoStartNextCycle: true,
      endBehavior: "stop",
      steps: [
        { label: "第一段", durationSec: 10 * 60, type: "generic" },
        { label: "翻面提醒", durationSec: 30, type: "generic" },
        { label: "收尾", durationSec: 3 * 60, type: "generic" },
      ],
    },
  };

  const DEFAULT_SEQUENCE_CONFIG = {
    name: "",
    steps: [{ label: "步驟 1", durationSec: 60, type: "generic" }],
    cycles: 1,
    autoStartNext: true,
    autoStartNextCycle: true,
    endBehavior: "stop",
  };

  const DEFAULT_SINGLE_DURATION = 60;

  let audioRemind;
  let audioEnd;
  let mode = "single";
  let sequenceInterval = null;
  let singleInterval = null;
  let overviewCollapsed = false;

  const sequenceState = {
    config: { ...DEFAULT_SEQUENCE_CONFIG },
    runtime: createDefaultSequenceRuntime(DEFAULT_SEQUENCE_CONFIG),
  };

  const singleState = {
    durationSec: DEFAULT_SINGLE_DURATION,
    remainingSec: DEFAULT_SINGLE_DURATION,
    isRunning: false,
    isPaused: false,
    lastTickTs: null,
    warned: false,
  };

  function createAudio(file) {
    const node = new Audio();
    node.src = file;
    node.loop = false;
    node.load();
    document.body.appendChild(node);
    return node;
  }

  function soundToggle(audio, play) {
    if (!audio) return;
    if (play) {
      audio.currentTime = 0;
      audio.play();
    } else {
      audio.pause();
      audio.currentTime = 0;
    }
  }

  function formatTime(totalSeconds) {
    const sec = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = sec % 60;
    const parts = [
      hours > 0 ? String(hours).padStart(2, "0") : null,
      String(minutes).padStart(2, "0"),
      String(seconds).padStart(2, "0"),
    ].filter(Boolean);
    return parts.join(":");
  }

  function persist(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      // ignore storage errors
    }
  }

  function readStorage(key) {
    try {
      const val = localStorage.getItem(key);
      return val ? JSON.parse(val) : null;
    } catch (_) {
      return null;
    }
  }

  function createDefaultSequenceRuntime(config) {
    const firstDuration = config.steps[0]?.durationSec || 1;
    return {
      cycleIndex: 0,
      stepIndex: 0,
      remainingSec: firstDuration,
      isRunning: false,
      isPaused: false,
      completed: false,
      lastTickTs: null,
    };
  }

  function clampDurationSeconds(value) {
    const n = Math.max(0, Number(value) || 0);
    return Math.floor(n);
  }

  function hydrateStateFromStorage() {
    const savedMode = readStorage(STORAGE_KEYS.mode);
    mode = savedMode === "sequence" ? "sequence" : "single";

    const savedConfig = readStorage(STORAGE_KEYS.sequenceConfig);
    sequenceState.config = validateSequenceConfig(savedConfig || DEFAULT_SEQUENCE_CONFIG)
      ? { ...DEFAULT_SEQUENCE_CONFIG, ...savedConfig }
      : { ...DEFAULT_SEQUENCE_CONFIG };

    const savedRuntime = readStorage(STORAGE_KEYS.sequenceRuntime);
    sequenceState.runtime = createDefaultSequenceRuntime(sequenceState.config);
    if (savedRuntime && typeof savedRuntime === "object") {
      sequenceState.runtime = {
        ...sequenceState.runtime,
        cycleIndex: savedRuntime.cycleIndex ?? 0,
        stepIndex: savedRuntime.stepIndex ?? 0,
        remainingSec:
          clampDurationSeconds(savedRuntime.remainingSec) ||
          sequenceState.runtime.remainingSec,
        isRunning: !!savedRuntime.isRunning,
        isPaused: !!savedRuntime.isPaused,
        completed: !!savedRuntime.completed,
        lastTickTs: savedRuntime.lastTickTs || null,
      };
      sequenceState.runtime.cycleIndex = Math.min(
        Math.max(0, sequenceState.runtime.cycleIndex),
        Math.max(0, sequenceState.config.cycles - 1)
      );
      sequenceState.runtime.stepIndex = Math.min(
        Math.max(0, sequenceState.runtime.stepIndex),
        Math.max(0, sequenceState.config.steps.length - 1)
      );
      sequenceState.runtime.remainingSec = Math.min(
        Math.max(1, sequenceState.runtime.remainingSec),
        sequenceState.config.steps[sequenceState.runtime.stepIndex]?.durationSec ||
          sequenceState.runtime.remainingSec
      );
      reconcileElapsedTime();
    }
  }

  function reconcileElapsedTime() {
    const { runtime, config } = sequenceState;
    if (!runtime.isRunning || !runtime.lastTickTs) return;
    const now = Date.now();
    let elapsedSec = (now - runtime.lastTickTs) / 1000;
    if (elapsedSec <= 0) return;

    runtime.remainingSec -= elapsedSec;
    while (runtime.remainingSec <= 0 && !runtime.completed) {
      const overshoot = Math.abs(runtime.remainingSec);
      const keptRunning = advanceAfterStepComplete(true);
      if (runtime.completed || !keptRunning) {
        runtime.remainingSec = keptRunning
          ? runtime.remainingSec
          : config.steps[runtime.stepIndex]?.durationSec || 0;
        break;
      }
      runtime.remainingSec = (config.steps[runtime.stepIndex]?.durationSec || 1) - overshoot;
    }
    runtime.lastTickTs = runtime.isRunning ? now : null;
  }

  function bindModeSwitch() {
    $(".mode-switch .btn").on("click", function () {
      const newMode = $(this).data("mode");
      if (newMode === mode) return;
      if (mode === "sequence") {
        pauseSequenceTimer(true);
      } else {
        pauseSingleTimer();
      }
      mode = newMode;
      persist(STORAGE_KEYS.mode, mode);
      updateModeUI();
    });
  }

  function updateModeUI() {
    $(".mode-switch .btn").removeClass("active");
    $(`.mode-switch .btn[data-mode="${mode}"]`).addClass("active");
    if (mode === "single") {
      $("#single-panel").removeClass("d-none");
      $("#sequence-panel").addClass("d-none");
    } else {
      $("#single-panel").addClass("d-none");
      $("#sequence-panel").removeClass("d-none");
    }
  }

  // -------- Single Timer --------
  function startSingleTimer() {
    if (singleState.isRunning) return;
    if (singleState.remainingSec <= 0) {
      singleState.remainingSec = singleState.durationSec;
    }
    singleState.isRunning = true;
    singleState.isPaused = false;
    singleState.warned = false;
    singleState.lastTickTs = Date.now();
    runSingleLoop();
    updateSingleUI();
  }

  function pauseSingleTimer() {
    if (!singleState.isRunning) return;
    singleState.isRunning = false;
    singleState.isPaused = true;
    stopSingleLoop();
    updateSingleUI();
  }

  function resumeSingleTimer() {
    if (singleState.isRunning || singleState.remainingSec <= 0) {
      startSingleTimer();
      return;
    }
    singleState.isRunning = true;
    singleState.isPaused = false;
    singleState.lastTickTs = Date.now();
    runSingleLoop();
    updateSingleUI();
  }

  function resetSingleTimer() {
    singleState.isRunning = false;
    singleState.isPaused = false;
    singleState.remainingSec = singleState.durationSec;
    singleState.lastTickTs = null;
    stopSingleLoop();
    soundToggle(audioRemind, false);
    soundToggle(audioEnd, false);
    updateSingleUI();
  }

  function adjustSingleTimer(delta, setValue) {
    if (singleState.isRunning && singleState.remainingSec <= 0) return;
    if (typeof setValue === "number") {
      singleState.durationSec = Math.max(1, Math.floor(setValue));
      singleState.remainingSec = singleState.durationSec;
    } else if (typeof delta === "number") {
      singleState.durationSec = Math.max(1, singleState.durationSec + delta);
      singleState.remainingSec = Math.min(
        singleState.durationSec,
        Math.max(1, singleState.remainingSec + delta)
      );
    }
    updateSingleUI();
  }

  function runSingleLoop() {
    stopSingleLoop();
    singleInterval = setInterval(() => {
      if (!singleState.isRunning) return;
      const now = Date.now();
      const delta = (now - (singleState.lastTickTs || now)) / 1000;
      singleState.lastTickTs = now;
      singleState.remainingSec -= delta;
      if (singleState.remainingSec <= 0) {
        singleState.remainingSec = 0;
        singleState.isRunning = false;
        soundToggle(audioEnd, true);
        stopSingleLoop();
      } else if (singleState.remainingSec <= 60 && !singleState.warned) {
        singleState.warned = true;
        soundToggle(audioRemind, true);
      } else if (singleState.remainingSec <= 55) {
        soundToggle(audioRemind, false);
      }
      updateSingleUI();
    }, 200);
  }

  function stopSingleLoop() {
    if (singleInterval) {
      clearInterval(singleInterval);
    }
    singleInterval = null;
  }

  function updateSingleUI() {
    $("#single-display").text(formatTime(singleState.remainingSec));
    let status = "待機中";
    if (singleState.isRunning) status = "執行中";
    else if (singleState.isPaused) status = "已暫停";
    else if (singleState.remainingSec === 0) status = "已完成";
    $("#single-status").text(status);
  }

  function bindSingleUI() {
    $("#single-start").on("click", startSingleTimer);
    $("#single-pause").on("click", pauseSingleTimer);
    $("#single-resume").on("click", resumeSingleTimer);
    $("#single-reset").on("click", resetSingleTimer);
    $("#single-adjustments button").on("click", function () {
      const delta = Number($(this).data("delta"));
      const setVal = $(this).data("set");
      adjustSingleTimer(delta, setVal !== undefined ? Number(setVal) : undefined);
    });
  }

  // -------- Sequence Timer --------
  function validateSequenceConfig(config) {
    if (!config || typeof config !== "object") return false;
    if (!Array.isArray(config.steps) || config.steps.length === 0) return false;
    if (!Number.isInteger(config.cycles) || config.cycles < 1) return false;
    for (const step of config.steps) {
      if (!Number.isFinite(step.durationSec) || step.durationSec < 1) return false;
    }
    return true;
  }

  function refreshEditorFromConfig() {
    const { config } = sequenceState;
    $("#sequence-name-input").val(config.name || "");
    $("#sequence-cycles").val(config.cycles || 1);
    $("#sequence-auto-start").prop("checked", !!config.autoStartNext);
    $("#sequence-auto-cycle").prop("checked", !!config.autoStartNextCycle);
    $("#sequence-end-behavior").val(config.endBehavior || "stop");

    const container = $("#sequence-steps-container");
    container.empty();
    config.steps.forEach((step, idx) => {
      container.append(buildStepEditorRow(step, idx));
    });
  }

  function buildStepEditorRow(step, idx) {
    const row = $(`
      <div class="step-editor-row" data-index="${idx}">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <div class="step-badge">步驟 ${idx + 1}</div>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-light step-move-up" title="上移">↑</button>
            <button class="btn btn-outline-light step-move-down" title="下移">↓</button>
            <button class="btn btn-outline-danger step-delete" title="刪除">✕</button>
          </div>
        </div>
        <div class="row g-2">
          <div class="col-sm-5">
            <label class="form-label small text-muted mb-1">標籤</label>
            <input type="text" class="form-control form-control-sm step-label" value="${step.label || ""}" placeholder="可留空">
          </div>
          <div class="col-sm-3">
            <label class="form-label small text-muted mb-1">分鐘</label>
            <input type="number" min="0" class="form-control form-control-sm step-min" value="${Math.floor(step.durationSec / 60)}">
          </div>
          <div class="col-sm-2">
            <label class="form-label small text-muted mb-1">秒數</label>
            <input type="number" min="0" max="59" class="form-control form-control-sm step-sec" value="${step.durationSec % 60}">
          </div>
          <div class="col-sm-2">
            <label class="form-label small text-muted mb-1">類型</label>
            <select class="form-select form-select-sm step-type">
              <option value="generic" ${step.type === "generic" ? "selected" : ""}>一般</option>
              <option value="work" ${step.type === "work" ? "selected" : ""}>工作</option>
              <option value="rest" ${step.type === "rest" ? "selected" : ""}>休息</option>
            </select>
          </div>
        </div>
      </div>
    `);
    row.find(".step-delete").on("click", () => {
      if ($("#sequence-steps-container .step-editor-row").length === 1) return;
      row.remove();
      renumberStepRows();
    });
    row.find(".step-move-up").on("click", () => moveStep(row, -1));
    row.find(".step-move-down").on("click", () => moveStep(row, 1));
    return row;
  }

  function moveStep(row, offset) {
    const siblings = $("#sequence-steps-container .step-editor-row");
    const idx = siblings.index(row);
    const target = idx + offset;
    if (target < 0 || target >= siblings.length) return;
    if (offset < 0) {
      row.insertBefore(siblings.eq(target));
    } else {
      row.insertAfter(siblings.eq(target));
    }
    renumberStepRows();
  }

  function renumberStepRows() {
    $("#sequence-steps-container .step-editor-row").each(function (idx) {
      $(this)
        .attr("data-index", idx)
        .find(".step-badge")
        .text(`步驟 ${idx + 1}`);
    });
  }

  function collectSequenceConfigFromEditor() {
    const steps = [];
    let errors = [];
    $("#sequence-steps-container .step-editor-row").each(function () {
      const label = $(this).find(".step-label").val() || "";
      const minutes = clampDurationSeconds($(this).find(".step-min").val()) || 0;
      const seconds = clampDurationSeconds($(this).find(".step-sec").val()) || 0;
      const type = $(this).find(".step-type").val() || "generic";
      const durationSec = minutes * 60 + seconds;
      if (durationSec < 1) {
        errors.push("每個步驟時間至少 1 秒。");
      }
      steps.push({ label, durationSec, type });
    });
    const cycles = parseInt($("#sequence-cycles").val(), 10) || 1;
    if (cycles < 1) errors.push("循環次數至少為 1。");
    if (steps.length === 0) errors.push("至少需要一個步驟。");

    const config = {
      name: $("#sequence-name-input").val() || "",
      steps,
      cycles,
      autoStartNext: $("#sequence-auto-start").prop("checked"),
      autoStartNextCycle: $("#sequence-auto-cycle").prop("checked"),
      endBehavior: "stop",
    };
    return { config, errors };
  }

  function saveSequenceConfig() {
    const { config, errors } = collectSequenceConfigFromEditor();
    const uniqueErrors = [...new Set(errors)];
    if (uniqueErrors.length) {
      $("#sequence-errors").text(uniqueErrors.join(" "));
      return false;
    }
    $("#sequence-errors").empty();
    sequenceState.config = config;
    persist(STORAGE_KEYS.sequenceConfig, config);
    sequenceState.runtime = createDefaultSequenceRuntime(config);
    persist(STORAGE_KEYS.sequenceRuntime, sequenceState.runtime);
    refreshOverview();
    updateSequenceUI();
    return true;
  }

  function handleTemplateApply(templateKey) {
    const template = SEQUENCE_TEMPLATES[templateKey];
    if (!template) return;
    sequenceState.config = JSON.parse(JSON.stringify(template));
    sequenceState.runtime = createDefaultSequenceRuntime(sequenceState.config);
    refreshEditorFromConfig();
    refreshOverview();
    updateSequenceUI();
    persist(STORAGE_KEYS.sequenceConfig, sequenceState.config);
    persist(STORAGE_KEYS.sequenceRuntime, sequenceState.runtime);
  }

  function addStepToEditor() {
    const row = buildStepEditorRow({ label: "", durationSec: 60, type: "generic" }, $("#sequence-steps-container .step-editor-row").length);
    $("#sequence-steps-container").append(row);
    renumberStepRows();
  }

  function sequenceTick() {
    if (!sequenceState.runtime.isRunning) return;
    const now = Date.now();
    const delta = (now - (sequenceState.runtime.lastTickTs || now)) / 1000;
    sequenceState.runtime.lastTickTs = now;
    sequenceState.runtime.remainingSec -= delta;
    if (sequenceState.runtime.remainingSec <= 0) {
      sequenceState.runtime.remainingSec = 0;
      onSequenceStepComplete();
    }
    updateSequenceUI();
    persist(STORAGE_KEYS.sequenceRuntime, sequenceState.runtime);
  }

  function runSequenceLoop() {
    stopSequenceLoop();
    sequenceInterval = setInterval(sequenceTick, 200);
  }

  function stopSequenceLoop() {
    if (sequenceInterval) {
      clearInterval(sequenceInterval);
    }
    sequenceInterval = null;
  }

  function startSequenceTimer() {
    if (!validateSequenceConfig(sequenceState.config)) {
      $("#sequence-errors").text("流程設定無效，請檢查步驟與循環。");
      return;
    }
    if (sequenceState.runtime.completed) {
      resetSequenceTimer();
    }
    sequenceState.runtime.isRunning = true;
    sequenceState.runtime.isPaused = false;
    sequenceState.runtime.completed = false;
    sequenceState.runtime.lastTickTs = Date.now();
    runSequenceLoop();
    updateSequenceUI();
    persist(STORAGE_KEYS.sequenceRuntime, sequenceState.runtime);
  }

  function pauseSequenceTimer(force) {
    if (!sequenceState.runtime.isRunning && !force) return;
    sequenceState.runtime.isRunning = false;
    sequenceState.runtime.isPaused = true;
    sequenceState.runtime.lastTickTs = null;
    stopSequenceLoop();
    updateSequenceUI();
    persist(STORAGE_KEYS.sequenceRuntime, sequenceState.runtime);
  }

  function resumeSequenceTimer() {
    if (sequenceState.runtime.completed) {
      resetSequenceTimer();
    }
    sequenceState.runtime.isRunning = true;
    sequenceState.runtime.isPaused = false;
    sequenceState.runtime.lastTickTs = Date.now();
    runSequenceLoop();
    updateSequenceUI();
    persist(STORAGE_KEYS.sequenceRuntime, sequenceState.runtime);
  }

  function resetSequenceTimer() {
    sequenceState.runtime = createDefaultSequenceRuntime(sequenceState.config);
    persist(STORAGE_KEYS.sequenceRuntime, sequenceState.runtime);
    stopSequenceLoop();
    updateSequenceUI();
  }

  function onSequenceStepComplete() {
    soundToggle(audioEnd, true);
    const continued = advanceAfterStepComplete(true);
    if (continued && sequenceState.runtime.isRunning) {
      sequenceState.runtime.lastTickTs = Date.now();
    }
  }

  function advanceAfterStepComplete(triggeredByTimer) {
    const { config, runtime } = sequenceState;
    const atLastStep = runtime.stepIndex >= config.steps.length - 1;
    if (!atLastStep) {
      runtime.stepIndex += 1;
      runtime.remainingSec = config.steps[runtime.stepIndex].durationSec;
      runtime.completed = false;
      if (triggeredByTimer && !config.autoStartNext) {
        runtime.isRunning = false;
        runtime.isPaused = true;
        runtime.lastTickTs = null;
        stopSequenceLoop();
        return false;
      }
      return runtime.isRunning;
    }

    const atLastCycle = runtime.cycleIndex >= config.cycles - 1;
    if (!atLastCycle) {
      runtime.cycleIndex += 1;
      runtime.stepIndex = 0;
      runtime.remainingSec = config.steps[0].durationSec;
      runtime.completed = false;
      if (triggeredByTimer && !config.autoStartNextCycle) {
        runtime.isRunning = false;
        runtime.isPaused = true;
        runtime.lastTickTs = null;
        stopSequenceLoop();
        return false;
      }
      return runtime.isRunning;
    }

    runtime.isRunning = false;
    runtime.isPaused = false;
    runtime.completed = true;
    runtime.remainingSec = 0;
    runtime.lastTickTs = null;
    stopSequenceLoop();
    return false;
  }

  function skipSequenceStep() {
    const wasRunning = sequenceState.runtime.isRunning;
    const continued = advanceAfterStepComplete(false);
    sequenceState.runtime.isRunning = sequenceState.config.autoStartNext && !sequenceState.runtime.completed && wasRunning;
    sequenceState.runtime.isPaused = !sequenceState.runtime.isRunning && !sequenceState.runtime.completed;
    sequenceState.runtime.lastTickTs = sequenceState.runtime.isRunning ? Date.now() : null;
    updateSequenceUI();
    persist(STORAGE_KEYS.sequenceRuntime, sequenceState.runtime);
    if (sequenceState.runtime.isRunning) runSequenceLoop();
  }

  function backSequenceStep() {
    const { runtime, config } = sequenceState;
    const wasRunning = runtime.isRunning;
    if (runtime.stepIndex > 0) {
      runtime.stepIndex -= 1;
    } else if (runtime.cycleIndex > 0) {
      runtime.cycleIndex -= 1;
      runtime.stepIndex = config.steps.length - 1;
    }
    runtime.remainingSec = config.steps[runtime.stepIndex].durationSec;
    runtime.completed = false;
    runtime.isRunning = wasRunning;
    runtime.isPaused = !wasRunning;
    runtime.lastTickTs = wasRunning ? Date.now() : null;
    updateSequenceUI();
    persist(STORAGE_KEYS.sequenceRuntime, runtime);
    if (wasRunning) runSequenceLoop();
  }

  function updateSequenceUI() {
    const { config, runtime } = sequenceState;
    const step = config.steps[runtime.stepIndex] || { label: "", durationSec: 0 };

    $("#sequence-name").text(config.name || "未命名流程");
    $("#sequence-display").text(formatTime(runtime.remainingSec));
    const label = step.label?.trim() ? step.label : `步驟 ${runtime.stepIndex + 1}`;
    $("#sequence-step-label").text(label);
    $("#sequence-step-progress").text(`${runtime.stepIndex + 1} / ${config.steps.length}`);
    $("#sequence-cycle-progress").text(`${runtime.cycleIndex + 1} / ${config.cycles}`);

    $("#sequence-mode-label")
      .text(runtime.completed ? "已完成" : runtime.isRunning ? "執行中" : runtime.isPaused ? "已暫停" : "待機中")
      .toggleClass("bg-info", !runtime.completed)
      .toggleClass("bg-success", runtime.completed);

    $("#sequence-complete").toggleClass("d-none", !runtime.completed);
    $("#sequence-start").prop("disabled", runtime.isRunning);
    $("#sequence-pause").prop("disabled", !runtime.isRunning);
    $("#sequence-resume").prop("disabled", runtime.isRunning || runtime.completed);
    $("#sequence-reset").prop("disabled", runtime.isRunning && !runtime.completed && runtime.remainingSec === config.steps[0].durationSec && runtime.stepIndex === 0 && runtime.cycleIndex === 0);
    $("#sequence-back").prop("disabled", runtime.stepIndex === 0 && runtime.cycleIndex === 0);
    $("#sequence-skip").prop("disabled", runtime.completed);
    $("#sequence-edit-toggle").prop("disabled", runtime.isRunning);
    $("#sequence-save, #sequence-add-step, #sequence-cancel-edit").prop("disabled", runtime.isRunning);

    refreshOverviewHighlight();
  }

  function refreshOverview() {
    const list = $("#sequence-overview-list");
    list.empty();
    sequenceState.config.steps.forEach((step, idx) => {
      const item = $(`
        <li class="list-group-item">
          <span>${step.label?.trim() || `步驟 ${idx + 1}`}</span>
          <span class="duration">${formatTime(step.durationSec)}</span>
        </li>
      `);
      if (idx === sequenceState.runtime.stepIndex) {
        item.addClass("active-step");
      }
      list.append(item);
    });
  }

  function refreshOverviewHighlight() {
    $("#sequence-overview-list .list-group-item").removeClass("active-step");
    $("#sequence-overview-list .list-group-item")
      .eq(sequenceState.runtime.stepIndex)
      .addClass("active-step");
  }

  function toggleOverview() {
    overviewCollapsed = !overviewCollapsed;
    $("#sequence-overview-list").toggleClass("d-none", overviewCollapsed);
  }

  function bindSequenceUI() {
    $("#sequence-start").on("click", startSequenceTimer);
    $("#sequence-pause").on("click", () => pauseSequenceTimer(false));
    $("#sequence-resume").on("click", resumeSequenceTimer);
    $("#sequence-reset").on("click", resetSequenceTimer);
    $("#sequence-skip").on("click", skipSequenceStep);
    $("#sequence-back").on("click", backSequenceStep);
    $("#sequence-edit-toggle").on("click", () => {
      if (sequenceState.runtime.isRunning) {
        pauseSequenceTimer(true);
      }
      $("#sequence-editor").toggleClass("d-none");
    });
    $("#sequence-save").on("click", saveSequenceConfig);
    $("#sequence-cancel-edit").on("click", () => {
      refreshEditorFromConfig();
      $("#sequence-errors").empty();
    });
    $("#sequence-add-step").on("click", addStepToEditor);
    $("#toggle-overview").on("click", toggleOverview);
    $('[data-template]').on("click", function () {
      const key = $(this).data("template");
      handleTemplateApply(key);
    });
  }

  function init() {
    audioRemind = createAudio(SOUND_FILES.remind);
    audioEnd = createAudio(SOUND_FILES.end);
    hydrateStateFromStorage();
    bindModeSwitch();
    bindSingleUI();
    bindSequenceUI();
    refreshEditorFromConfig();
    refreshOverview();
    updateSequenceUI();
    updateSingleUI();
    updateModeUI();
    runSequenceLoop();
  }

  $(document).ready(init);
})();
