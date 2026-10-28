#!/usr/bin/env node
/**
 * Herdr Multi-Agent Team Orchestrator (Universal / Spec-Driven Edition)
 *
 * 4 Specialised Roles:
 * 1. PLANNER (Tự chọn: OpenCode hoặc Antigravity): Biến yêu cầu sơ sài thành đặc tả kỹ thuật chi tiết (.team/PLAN.md)
 * 2. CODER (Tự chọn: OpenCode hoặc Antigravity): Đọc PLAN.md, viết code, sửa bug (.team/CODE_CHANGES.md)
 * 3. TESTER (Antigravity): Tự đọc code, viết test cases, bắt lỗi góc khuất, verify (.team/TEST_RESULTS.md)
 * 4. REVIEWER (Antigravity - Read-Only): Soi git diff, kiểm tra chất lượng, chốt hạ hoặc yêu cầu sửa
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const execFileAsync = promisify(execFile);

const ROOT_DIR = process.cwd();
const TEAM_DIR = path.join(ROOT_DIR, '.team');
const TEAM_CONFIG_FILE = path.join(TEAM_DIR, 'team_config.json');
const LEGACY_CODER_CONFIG_FILE = path.join(TEAM_DIR, 'coder_config.json');

const AUTONOMOUS_RULES = `
[QUY TẮC BẮT BUỘC ĐỂ CHẠY TỰ ĐỘNG 100% - KHÔNG DỪNG GIỮA CHỪNG]:
1. TUYỆT ĐỐI KHÔNG dùng công cụ hỏi ý kiến người dùng (như ask_question) và KHÔNG dừng lại chờ lệnh tiếp theo.
2. Hãy tự suy luận logic, tự phân tích và tự đưa ra quyết định kỹ thuật tối ưu nhất để giải quyết triệt để vấn đề.
3. Tuyệt đối KHÔNG chạy các lệnh terminal mang tính tương tác chờ người dùng gõ phím (như vim, nano, less, git commit không kèm -m, npm login,...).
4. TUYỆT ĐỐI KHÔNG tự ý git push hay git reset --hard.
`.trim();

function normalizePath(p) {
  if (!p) return '';
  return path.resolve(p).toLowerCase().replace(/\\/g, '/');
}

function getProjectPrefix() {
  const base = path.basename(ROOT_DIR).toLowerCase().replace(/[^a-z0-9]/g, '_');
  return base.slice(0, 10).replace(/_+$/, '') || 'team';
}

// --- Interactive Selection for AI Roles & Execution Modes (Arrow Keys + Enter) ---

async function selectOptionInteractive(titleText, options, defaultChoiceId) {
  if (!process.stdin.isTTY) {
    const found = options.find((o) => o.id === defaultChoiceId);
    return found ? found.id : options[0].id;
  }

  let selectedIndex = options.findIndex((o) => o.id === defaultChoiceId);
  if (selectedIndex === -1) selectedIndex = 0;

  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const boxWidth = Math.max(76, titleText.length + 6);

    const render = (firstTime = false) => {
      if (!firstTime) {
        readline.moveCursor(process.stdout, 0, -(options.length + 3));
      }
      console.log('\n┌' + '─'.repeat(boxWidth) + '┐');
      console.log(`│ ${titleText}`.padEnd(boxWidth + 1) + '│');
      console.log('└' + '─'.repeat(boxWidth) + '┘');

      options.forEach((opt, idx) => {
        const isSelected = idx === selectedIndex;
        const pointer = isSelected ? '\x1b[36m❯ [•]\x1b[0m' : '   [ ]';
        const title = isSelected ? `\x1b[1m\x1b[36m${opt.name}\x1b[0m` : opt.name;
        console.log(`${pointer} ${title.padEnd(28)} - ${opt.desc}`);
      });
    };

    render(true);

    const onKeypress = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.exit(0);
      }

      if (key.name === 'up') {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        render(false);
      } else if (key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % options.length;
        render(false);
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        const chosen = options[selectedIndex];
        console.log(`\n🎯 Đã chọn: \x1b[32m\x1b[1m${chosen.name}\x1b[0m\n`);
        resolve(chosen.id);
      }
    };

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    }

    process.stdin.on('keypress', onKeypress);
  });
}

async function selectModelInteractive(roleTitle, defaultChoice = 'opencode') {
  const options = [
    {
      id: 'opencode',
      name: 'OpenCode',
      desc: 'Mạnh về bao quát toàn cục dự án, kiến trúc hệ thống, terminal commands'
    },
    {
      id: 'agy',
      name: 'Antigravity',
      desc: 'Mạnh về suy luận logic sâu, phân tích cú pháp chi tiết, xử lý ca khó'
    }
  ];
  return selectOptionInteractive(`🤖 CHỌN MODEL CHO [${roleTitle}] (Dùng phím ↑ / ↓, bấm Enter)`, options, defaultChoice);
}

async function selectModeInteractive(defaultChoice = 'once') {
  const options = [
    {
      id: 'once',
      name: 'Tiêu chuẩn (1 lượt)',
      desc: 'Chạy tuần tự 1 vòng (Planner -> Coder -> Tester -> Reviewer) rồi kết thúc'
    },
    {
      id: 'loop',
      name: 'Xoay vòng tự động',
      desc: 'Lặp lại: Reviewer đề xuất kế hoạch -> Planner làm tiếp -> Coder -> Tester...'
    }
  ];
  return selectOptionInteractive('🔄 CHỌN CHẾ ĐỘ THỰC THI (Dùng phím ↑ / ↓, bấm Enter)', options, defaultChoice);
}

async function selectMaxLoopsInteractive(defaultChoice = '3') {
  const options = [
    {
      id: '2',
      name: '2 vòng lặp',
      desc: 'Hoàn thiện tính năng + 1 vòng kiểm tra & tối ưu hóa bổ sung'
    },
    {
      id: '3',
      name: '3 vòng lặp (Khuyên dùng)',
      desc: 'Cân bằng tối ưu giữa chiều sâu triển khai và thời gian thực thi'
    },
    {
      id: '5',
      name: '5 vòng lặp',
      desc: 'Phù hợp tái cấu trúc sâu hoặc phát triển nhiều module liên hoàn'
    },
    {
      id: '10',
      name: '10 vòng lặp',
      desc: 'Tự trị dài hạn (Long-running autonomous development loop)'
    }
  ];
  const chosen = await selectOptionInteractive('🔁 CHỌN SỐ VÒNG LẶP TỐI ĐA (Dùng phím ↑ / ↓, bấm Enter)', options, String(defaultChoice));
  return parseInt(chosen, 10) || 3;
}

// --- Herdr CLI Helpers ---

async function runHerdr(args, options = {}) {
  try {
    const { stdout } = await execFileAsync('herdr', args, {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      ...options
    });
    return stdout.trim();
  } catch (err) {
    const stderr = err.stderr ? err.stderr.trim() : '';
    throw new Error(stderr || err.message);
  }
}

async function runHerdrJson(args, options = {}) {
  const output = await runHerdr(args, options);
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkHerdrServer() {
  try {
    const status = await runHerdr(['status']);
    return status.includes('status: running') || status.includes('endpoint_compatible: yes');
  } catch {
    return false;
  }
}

async function ensureHerdrServer() {
  if (await checkHerdrServer()) return true;

  console.log('⚡ Herdr server chưa chạy. Đang tự động khởi động server ngầm...');
  try {
    await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      'Start-Process herdr -ArgumentList "server" -WindowStyle Hidden'
    ]);

    for (let i = 0; i < 10; i++) {
      await delay(600);
      if (await checkHerdrServer()) {
        console.log('✅ Herdr server đã sẵn sàng.');
        return true;
      }
    }
  } catch (err) {
    console.error('Không thể tự động bật herdr server:', err.message);
  }
  return false;
}

async function getWorkspaces() {
  try {
    const res = await runHerdrJson(['workspace', 'list']);
    return res?.result?.workspaces || [];
  } catch {
    return [];
  }
}

async function getLiveAgents() {
  try {
    const res = await runHerdrJson(['agent', 'list']);
    return res?.result?.agents || [];
  } catch {
    return [];
  }
}

async function getPanes(workspaceId = null) {
  try {
    const args = ['pane', 'list'];
    if (workspaceId) args.push('--workspace', workspaceId);
    const res = await runHerdrJson(args);
    return res?.result?.panes || [];
  } catch {
    return [];
  }
}

async function waitForAgentIdle(agentName, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const info = await runHerdrJson(['agent', 'get', agentName]);
      const status = info?.result?.agent?.agent_status;
      if (status === 'idle' || status === 'done') {
        return true;
      }
    } catch {}
    await delay(1500);
  }
  return false;
}

// --- Team Setup (PLANNER, CODER, TESTER, REVIEWER) ---

async function ensureWorkspaceAndAgents(chosenPlannerKind, chosenCoderKind) {
  console.log(`🔍 Đang kiểm tra không gian làm việc Herdr cho: "${ROOT_DIR}"...`);

  const currentNorm = normalizePath(ROOT_DIR);
  const [workspaces, liveAgents] = await Promise.all([
    getWorkspaces(),
    getLiveAgents()
  ]);

  const projectName = path.basename(ROOT_DIR);
  const teamLabel = `${projectName} (Team)`;

  const prefix = getProjectPrefix();
  const rolePlanner = `${prefix}_planner`;
  const roleCoder = `${prefix}_coder`;
  const roleTester = `${prefix}_tester`;
  const roleReviewer = `${prefix}_reviewer`;
  const teamRoles = [rolePlanner, roleCoder, roleTester, roleReviewer];

  const activeRoles = {
    PLANNER: rolePlanner,
    CODER: roleCoder,
    TESTER: roleTester,
    REVIEWER: roleReviewer,
    PLANNER_KIND: chosenPlannerKind,
    CODER_KIND: chosenCoderKind
  };

  const agentByName = {};
  for (const a of liveAgents) {
    if (a.name) agentByName[a.name] = a;
  }

  // Check if all 4 agents are already running with matching roles and CWD
  const plannerReady =
    agentByName[rolePlanner] &&
    normalizePath(agentByName[rolePlanner].cwd) === currentNorm &&
    agentByName[rolePlanner].agent === chosenPlannerKind;
  const coderReady =
    agentByName[roleCoder] &&
    normalizePath(agentByName[roleCoder].cwd) === currentNorm &&
    agentByName[roleCoder].agent === chosenCoderKind;
  const testerReady =
    agentByName[roleTester] &&
    normalizePath(agentByName[roleTester].cwd) === currentNorm &&
    agentByName[roleTester].agent === 'agy';
  const reviewerReady =
    agentByName[roleReviewer] &&
    normalizePath(agentByName[roleReviewer].cwd) === currentNorm &&
    agentByName[roleReviewer].agent === 'agy';

  if (plannerReady && coderReady && testerReady && reviewerReady) {
    console.log('✅ Đã tìm thấy đầy đủ 4 AI Agent sẵn sàng trong project:');
    console.log(`   - [PLANNER]  ${rolePlanner} (${chosenPlannerKind === 'agy' ? 'Antigravity' : 'OpenCode'})`);
    console.log(`   - [CODER]    ${roleCoder} (${chosenCoderKind === 'agy' ? 'Antigravity' : 'OpenCode'})`);
    console.log(`   - [TESTER]   ${roleTester} (Antigravity)`);
    console.log(`   - [REVIEWER] ${roleReviewer} (Antigravity - Read-Only)`);
    return activeRoles;
  }

  // Locate dedicated team workspace (NEVER hijack non-team workspaces like dev servers)
  let targetWs = null;

  // 1. Check if any existing team agent is already attached to a workspace
  const matchingTeamAgent = liveAgents.find(
    (a) => teamRoles.includes(a.name) && normalizePath(a.cwd) === currentNorm
  );
  if (matchingTeamAgent && matchingTeamAgent.workspace_id) {
    targetWs = workspaces.find((w) => w.workspace_id === matchingTeamAgent.workspace_id);
  }

  // 2. Check workspace with exact team label: "${projectName} (Team)"
  if (!targetWs) {
    targetWs = workspaces.find((w) => w.label === teamLabel);
  }

  // If no dedicated team workspace exists, create a fresh 2x2 workspace
  if (!targetWs) {
    console.log(`📁 Tạo workspace đội ngũ AI mới trên Herdr: "${teamLabel}"...`);
    const wsRes = await runHerdrJson([
      'workspace',
      'create',
      '--label',
      teamLabel,
      '--cwd',
      ROOT_DIR,
      '--focus'
    ]);
    targetWs = wsRes?.result?.workspace;
    const rootPaneId = wsRes?.result?.root_pane?.pane_id;

    if (!targetWs || !rootPaneId) {
      throw new Error('Không thể khởi tạo workspace trên Herdr');
    }

    console.log('📐 Đang chia bố cục 2x2 cho 4 AI Agents...');

    // Split 1: Root (Top-Left) split right -> pCoder (Top-Right)
    const splitRightRes = await runHerdrJson([
      'pane',
      'split',
      '--pane',
      rootPaneId,
      '--direction',
      'right',
      '--cwd',
      ROOT_DIR,
      '--no-focus'
    ]);
    const pCoderId = splitRightRes?.result?.pane?.pane_id;

    // Split 2: Root (Top-Left) split down -> pTester (Bottom-Left)
    const splitDown1 = await runHerdrJson([
      'pane',
      'split',
      '--pane',
      rootPaneId,
      '--direction',
      'down',
      '--cwd',
      ROOT_DIR,
      '--no-focus'
    ]);
    const pTesterId = splitDown1?.result?.pane?.pane_id;

    // Split 3: pCoder (Top-Right) split down -> pReviewer (Bottom-Right)
    const splitDown2 = await runHerdrJson([
      'pane',
      'split',
      '--pane',
      pCoderId,
      '--direction',
      'down',
      '--cwd',
      ROOT_DIR,
      '--no-focus'
    ]);
    const pReviewerId = splitDown2?.result?.pane?.pane_id;

    // 1. PLANNER: OpenCode OR Antigravity
    const plannerLabel = chosenPlannerKind === 'agy' ? 'Antigravity' : 'OpenCode';
    const plannerArgs = chosenPlannerKind === 'agy' ? ['--', '--dangerously-skip-permissions'] : ['--', '--auto'];
    console.log(`🚀 [1/4] Khởi động PLANNER: ${rolePlanner} (${plannerLabel})...`);
    await runHerdr([
      'agent',
      'start',
      rolePlanner,
      '--kind',
      chosenPlannerKind,
      '--pane',
      rootPaneId,
      ...plannerArgs
    ]);

    // 2. CODER: OpenCode OR Antigravity
    const coderLabel = chosenCoderKind === 'agy' ? 'Antigravity' : 'OpenCode';
    const coderArgs = chosenCoderKind === 'agy' ? ['--', '--dangerously-skip-permissions'] : ['--', '--auto'];
    console.log(`🚀 [2/4] Khởi động CODER: ${roleCoder} (${coderLabel})...`);
    await runHerdr([
      'agent',
      'start',
      roleCoder,
      '--kind',
      chosenCoderKind,
      '--pane',
      pCoderId,
      ...coderArgs
    ]);

    // 3. TESTER: Antigravity (--dangerously-skip-permissions)
    console.log(`🚀 [3/4] Khởi động TESTER: ${roleTester} (Antigravity)...`);
    await runHerdr([
      'agent',
      'start',
      roleTester,
      '--kind',
      'agy',
      '--pane',
      pTesterId,
      '--',
      '--dangerously-skip-permissions'
    ]);

    // 4. REVIEWER: Antigravity (--dangerously-skip-permissions - Read-Only prompt)
    console.log(`🚀 [4/4] Khởi động REVIEWER: ${roleReviewer} (Antigravity - Read-Only)...`);
    await runHerdr([
      'agent',
      'start',
      roleReviewer,
      '--kind',
      'agy',
      '--pane',
      pReviewerId,
      '--',
      '--dangerously-skip-permissions'
    ]);

    console.log('⏳ Đợi các AI hoàn tất khởi động...');
    await Promise.all([
      waitForAgentIdle(rolePlanner, 45000),
      waitForAgentIdle(roleCoder, 45000),
      waitForAgentIdle(roleTester, 45000),
      waitForAgentIdle(roleReviewer, 45000)
    ]);
  } else {
    // Existing dedicated team workspace: ensure at least 4 panes exist
    let wsPanes = (await getPanes(targetWs.workspace_id)).filter((p) => p.workspace_id === targetWs.workspace_id);
    while (wsPanes.length < 4) {
      const paneToSplit = wsPanes[wsPanes.length - 1].pane_id;
      const direction = wsPanes.length === 1 ? 'right' : 'down';
      await runHerdrJson([
        'pane',
        'split',
        '--pane',
        paneToSplit,
        '--direction',
        direction,
        '--cwd',
        ROOT_DIR,
        '--no-focus'
      ]);
      wsPanes = (await getPanes(targetWs.workspace_id)).filter((p) => p.workspace_id === targetWs.workspace_id);
    }

    const assignedPanes = [
      { role: rolePlanner, kind: chosenPlannerKind, paneId: wsPanes[0].pane_id, title: 'PLANNER' },
      { role: roleCoder, kind: chosenCoderKind, paneId: wsPanes[1].pane_id, title: 'CODER' },
      { role: roleTester, kind: 'agy', paneId: wsPanes[2].pane_id, title: 'TESTER' },
      { role: roleReviewer, kind: 'agy', paneId: wsPanes[3].pane_id, title: 'REVIEWER' }
    ];

    for (const item of assignedPanes) {
      const currentAgent = liveAgents.find((a) => a.name === item.role);
      const paneAgent = liveAgents.find((a) => a.pane_id === item.paneId);
      const agentKindLabel = item.kind === 'agy' ? 'Antigravity' : 'OpenCode';
      const agentArgs = item.kind === 'agy' ? ['--', '--dangerously-skip-permissions'] : ['--', '--auto'];

      if (currentAgent && currentAgent.agent === item.kind && normalizePath(currentAgent.cwd) === currentNorm) {
        // Agent is already running and properly configured
        continue;
      }

      if (paneAgent) {
        if (paneAgent.agent === item.kind && normalizePath(paneAgent.cwd) === currentNorm) {
          console.log(`🏷️  Gán pane ${item.paneId} thành [${item.title}] (${item.role})...`);
          try {
            await runHerdr(['agent', 'rename', item.paneId, item.role]);
          } catch {}
          continue;
        } else {
          console.log(`🔄 Khởi động lại [${item.title}] trên pane ${item.paneId} (${agentKindLabel})...`);
          try {
            await runHerdr(['agent', 'send-keys', item.paneId, 'ctrl+c']);
            await delay(1000);
          } catch {}
        }
      }

      console.log(`🚀 Khởi động [${item.title}]: ${item.role} (${agentKindLabel}) trên pane ${item.paneId}...`);
      try {
        await runHerdr([
          'agent',
          'start',
          item.role,
          '--kind',
          item.kind,
          '--pane',
          item.paneId,
          ...agentArgs
        ]);
      } catch (startErr) {
        if (startErr.message && startErr.message.includes('agent_pane_busy')) {
          console.log(`⚠️ Pane ${item.paneId} đang bận. Đang tạo pane mới cho [${item.title}]...`);
          const splitRes = await runHerdrJson([
            'pane',
            'split',
            '--pane',
            item.paneId,
            '--direction',
            'down',
            '--cwd',
            ROOT_DIR,
            '--no-focus'
          ]);
          const newPaneId = splitRes?.result?.pane?.pane_id;
          if (newPaneId) {
            await runHerdr([
              'agent',
              'start',
              item.role,
              '--kind',
              item.kind,
              '--pane',
              newPaneId,
              ...agentArgs
            ]);
          }
        } else {
          throw startErr;
        }
      }
    }

    console.log('⏳ Đợi các AI hoàn tất khởi động...');
    await Promise.all([
      waitForAgentIdle(rolePlanner, 45000),
      waitForAgentIdle(roleCoder, 45000),
      waitForAgentIdle(roleTester, 45000),
      waitForAgentIdle(roleReviewer, 45000)
    ]);
  }

  console.log('\n🎉 Đội ngũ 4 AI Agents đã sẵn sàng:');
  console.log(`   1. [PLANNER]  ${activeRoles.PLANNER} (${chosenPlannerKind === 'agy' ? 'Antigravity' : 'OpenCode'})`);
  console.log(`   2. [CODER]    ${activeRoles.CODER} (${chosenCoderKind === 'agy' ? 'Antigravity' : 'OpenCode'})`);
  console.log(`   3. [TESTER]   ${activeRoles.TESTER} (Antigravity)`);
  console.log(`   4. [REVIEWER] ${activeRoles.REVIEWER} (Antigravity - Read-Only)\n`);

  return activeRoles;
}

// --- Prompt & Execute With Indefinite Wait & Heartbeat ---

async function promptAgent(target, promptText) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`▶ GIAO VIỆC CHO: [${target.toUpperCase()}]`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  const startTime = Date.now();

  try {
    await runHerdr(['agent', 'focus', target]);
  } catch {}

  // Periodic heartbeat timer (informs user every 60s)
  const heartbeatTimer = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const minutes = Math.floor(elapsedSec / 60);
    const seconds = elapsedSec % 60;
    console.log(`   ⏳ [${target.toUpperCase()}] Đang tự động xử lý chuyên sâu... (${minutes}m ${seconds}s)`);
  }, 60000);

  try {
    // Indefinite wait: wait until agent settles into idle or done without arbitrary timeout
    await runHerdrJson([
      'agent',
      'prompt',
      target,
      promptText,
      '--wait'
    ]);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✔ [${target.toUpperCase()}] Hoàn thành công việc trong ${elapsed}s.`);
  } catch (err) {
    // If any warning/signal, check live status in Herdr
    try {
      const agentInfo = await runHerdrJson(['agent', 'get', target]);
      const status = agentInfo?.result?.agent?.agent_status;
      if (status === 'working') {
        console.log(`⚡ [${target.toUpperCase()}] Vẫn đang tiếp tục làm việc... Tiếp tục chờ hoàn tất...`);
        await runHerdrJson(['agent', 'wait', target, '--until', 'idle', '--until', 'done']);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✔ [${target.toUpperCase()}] Hoàn thành công việc trong ${elapsed}s.`);
        return;
      } else if (status === 'idle' || status === 'done') {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✔ [${target.toUpperCase()}] Hoàn thành công việc trong ${elapsed}s.`);
        return;
      }
    } catch {}

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`✖ [${target.toUpperCase()}] Lỗi thực thi sau ${elapsed}s: ${err.message}`);
    throw err;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

// --- Main 4-Role Task Execution Pipeline (With Stage Resume & Loop Mode) ---

async function runTaskPipeline(taskDescription, roles, startStage = 'planner', mode = 'once', maxLoops = 1) {
  const isLoopMode = mode === 'loop';
  const totalLoops = isLoopMode ? maxLoops : 1;

  console.log('\n============================================================');
  console.log('🤖 BẮT ĐẦU QUY TRÌNH ĐỘI NGŨ AI TỰ ĐỘNG');
  console.log(`📁 Thư mục dự án: ${ROOT_DIR}`);
  console.log(`📋 Nhiệm vụ: "${taskDescription || 'Thực hiện theo kế hoạch tại .team/PLAN.md'}"`);
  console.log(`📐 PLANNER: ${roles.PLANNER_KIND === 'agy' ? 'Antigravity' : 'OpenCode'}`);
  console.log(`⚙️  CODER:   ${roles.CODER_KIND === 'agy' ? 'Antigravity' : 'OpenCode'}`);
  if (isLoopMode) {
    console.log(`🔁 Chế độ:   XOAY VÒNG TỰ ĐỘNG (Tối đa ${totalLoops} chu kỳ lặp)`);
  } else {
    console.log(`▶️  Chế độ:   TIÊU CHUẨN (1 lượt hoàn tất)`);
  }
  if (startStage !== 'planner') {
    console.log(`⏩ Bắt đầu từ giai đoạn: [${startStage.toUpperCase()}]`);
  }
  console.log('============================================================');

  await fs.mkdir(TEAM_DIR, { recursive: true });

  const totalStart = Date.now();

  for (let cycle = 1; cycle <= totalLoops; cycle++) {
    if (totalLoops > 1) {
      console.log(`\n🌀 >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
      console.log(`🌀 BẮT ĐẦU CHU KỲ XOAY VÒNG ${cycle}/${totalLoops}`);
      console.log(`🌀 >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>\n`);
    }

    // STAGE 1: PLANNER
    if (cycle === 1) {
      if (startStage === 'planner') {
        const plannerPrompt = `
${AUTONOMOUS_RULES}

[YÊU CẦU TỪ NGƯỜI DÙNG]:
${taskDescription}

Bạn là Lead Architect kiêm Product Planner (PLANNER). Model của bạn: ${roles.PLANNER_KIND === 'agy' ? 'Antigravity' : 'OpenCode'}.
Nhiệm vụ tối quan trọng: Biến yêu cầu trên thành một BẢN ĐẶC TẢ KỸ THUẬT VÀ KẾ HOẠCH CHI TIẾT CHUẨN CHỈ.

Hãy khảo sát codebase hiện tại và ghi toàn bộ vào file '.team/PLAN.md' bao gồm:
1. Phân tích chi tiết yêu cầu & mục tiêu cốt lõi (User Intent & Scope).
2. Danh sách các file cần tác động (tạo mới, sửa, xóa) và đường dẫn chính xác.
3. Đặc tả chi tiết giải pháp kỹ thuật (functions, types, logic xử lý, API payload/response nếu có).
4. Danh sách các trường hợp ngoại lệ, rủi ro và ca biên (Edge cases & Boundary conditions) cần lưu ý.
5. Checklist công việc từng bước (Step-by-step tasks với checkbox) cho CODER thực hiện.
6. Yêu cầu kiểm thử cho TESTER.

Khi hoàn thành, trả lời: 'Kế hoạch kỹ thuật đã sẵn sàng tại .team/PLAN.md'.
`.trim();

        await promptAgent(roles.PLANNER, plannerPrompt);
      } else {
        console.log('⏩ Bỏ qua bước [PLANNER] (Sử dụng bản kế hoạch có sẵn tại .team/PLAN.md).');
      }
    } else {
      // Cycle > 1: Planner takes feedback from Reviewer and plans next sprint
      console.log(`📐 [PLANNER] Tiếp nhận đánh giá & đề xuất từ Reviewer để lập kế hoạch Chu kỳ ${cycle}...`);
      const nextPlanPrompt = `
${AUTONOMOUS_RULES}

[CHẾ ĐỘ XOAY VÒNG - CHU KỲ ${cycle}/${totalLoops}]
Nhiệm vụ tổng thể ban đầu của User:
${taskDescription || 'Tiếp tục hoàn thiện dự án theo kế hoạch tại .team/PLAN.md'}

REVIEWER vừa hoàn thành đánh giá chu kỳ trước và đã nêu các THIẾU SÓT hoặc ĐỀ XUẤT KẾ HOẠCH TRIỂN KHAI TIẾP THEO trong file '.team/REVIEW.md'.
Đồng thời bạn có thể tham khảo '.team/CODE_CHANGES.md' và '.team/TEST_RESULTS.md'.

Bạn là Lead Architect kiêm Product Planner (PLANNER). Model của bạn: ${roles.PLANNER_KIND === 'agy' ? 'Antigravity' : 'OpenCode'}.
Nhiệm vụ:
1. Đọc kỹ đánh giá, thiếu sót và đề xuất kế hoạch mới trong '.team/REVIEW.md'.
2. Khảo sát codebase hiện tại để nắm tình trạng mã nguồn mới nhất sau chu kỳ trước.
3. Cập nhật lại file '.team/PLAN.md' thành KẾ HOẠCH HÀNH ĐỘNG CHO CHU KỲ ${cycle}:
   - Mục tiêu cụ thể cần giải quyết trong chu kỳ này.
   - Danh sách file cần sửa đổi hoặc tạo mới.
   - Checklist từng bước rõ ràng cho CODER thực hiện.
   - Yêu cầu kiểm thử cho TESTER.

Khi hoàn thành, trả lời: 'Kế hoạch kỹ thuật cho Chu kỳ ${cycle} đã sẵn sàng tại .team/PLAN.md'.
`.trim();
      await promptAgent(roles.PLANNER, nextPlanPrompt);
    }

    // STAGE 2: CODER
    if (cycle === 1 && startStage !== 'planner' && startStage !== 'coder') {
      console.log('⏩ Bỏ qua bước [CODER].');
    } else {
      const coderPrompt = cycle === 1 ? `
${AUTONOMOUS_RULES}

Bạn là Senior Software Engineer (CODER). Model của bạn: ${roles.CODER_KIND === 'agy' ? 'Antigravity' : 'OpenCode'}.
Nhiệm vụ: Đọc kỹ bản đặc tả kỹ thuật và kế hoạch tại '.team/PLAN.md' do PLANNER lập ra.
1. Tiến hành viết code, chỉnh sửa, thêm, xóa các file theo đúng checklist trong PLAN.md.
2. Tuân thủ Karpathy Guidelines: Không suy đoán, code tối giản, thay đổi chính xác có mục tiêu (surgical changes), không sửa code ngoài phạm vi.
3. Xử lý triệt để các trường hợp biên và ngoại lệ mà PLANNER đã cảnh báo.
4. Ghi chép tóm tắt toàn bộ thay đổi mã nguồn vào file '.team/CODE_CHANGES.md' (file nào đã sửa, logic gì đã thêm, lý do).

Khi hoàn tất, trả lời: 'Code đã hoàn thành. Chi tiết tại .team/CODE_CHANGES.md'.
`.trim() : `
${AUTONOMOUS_RULES}

[CHẾ ĐỘ XOAY VÒNG - CHU KỲ ${cycle}/${totalLoops}]
Bạn là Senior Software Engineer (CODER). Model của bạn: ${roles.CODER_KIND === 'agy' ? 'Antigravity' : 'OpenCode'}.
Nhiệm vụ: Đọc kỹ bản kế hoạch mới cho Chu kỳ ${cycle} tại '.team/PLAN.md' vừa được PLANNER cập nhật.
1. Tiến hành viết code, chỉnh sửa theo đúng checklist của Chu kỳ ${cycle} trong PLAN.md.
2. Tuân thủ Karpathy Guidelines: Không suy đoán, code tối giản, thay đổi chính xác có mục tiêu (surgical changes).
3. Xử lý các thiếu sót hoặc hoàn thiện các tính năng tiếp theo.
4. Cập nhật lại danh mục thay đổi mã nguồn vào file '.team/CODE_CHANGES.md'.

Khi hoàn tất, trả lời: 'Code Chu kỳ ${cycle} đã hoàn thành. Chi tiết tại .team/CODE_CHANGES.md'.
`.trim();

      await promptAgent(roles.CODER, coderPrompt);
    }

    // STAGE 3: TESTER
    if (cycle === 1 && startStage === 'reviewer') {
      console.log('⏩ Bỏ qua bước [TESTER].');
    } else {
      const testerPrompt = cycle === 1 ? `
${AUTONOMOUS_RULES}

Bạn là QA & Testing Engineer (TESTER).
Nhiệm vụ: Đọc '.team/PLAN.md' và các thay đổi code tại '.team/CODE_CHANGES.md'.
1. Tự phân tích logic code mới viết, suy luận các kịch bản kiểm thử:
   - Happy path (tính năng chạy bình thường).
   - Edge cases & Corner cases (dữ liệu rỗng, dữ liệu sai định dạng, timeout, ranh giới mốc số liệu,...).
2. Tự viết test cases hoặc bổ sung unit/integration tests nếu dự án có test framework.
3. Chạy kiểm thử thực tế trong terminal (ví dụ: npm test, npm run build, npm run lint,... nếu có).
4. Ghi toàn bộ kết quả kiểm thử, các test case đã chạy và các lỗi phát hiện (nếu có) vào '.team/TEST_RESULTS.md'.

Khi hoàn tất, trả lời: 'Kiểm thử hoàn tất. Kết quả tại .team/TEST_RESULTS.md'.
`.trim() : `
${AUTONOMOUS_RULES}

[CHẾ ĐỘ XOAY VÒNG - CHU KỲ ${cycle}/${totalLoops}]
Bạn là QA & Testing Engineer (TESTER).
Nhiệm vụ: Đọc '.team/PLAN.md' và các thay đổi code tại '.team/CODE_CHANGES.md' của Chu kỳ ${cycle}.
1. Phân tích logic code mới ở chu kỳ này, suy luận các kịch bản kiểm thử cho tính năng mới và hồi quy (regression).
2. Chạy kiểm thử thực tế trong terminal (ví dụ: npm test, npm run build, npm run lint,... nếu có).
3. Cập nhật toàn bộ kết quả kiểm thử vào '.team/TEST_RESULTS.md'.

Khi hoàn tất, trả lời: 'Kiểm thử Chu kỳ ${cycle} hoàn tất. Kết quả tại .team/TEST_RESULTS.md'.
`.trim();

      await promptAgent(roles.TESTER, testerPrompt);
    }

    // STAGE 4: REVIEWER (READ-ONLY)
    const isLastCycle = cycle === totalLoops;
    const reviewerPrompt = totalLoops === 1 ? `
${AUTONOMOUS_RULES}

Bạn là Principal Code Reviewer (REVIEWER).
QUY TẮC BẮT BUỘC: Bạn ở CHẾ ĐỘ READ-ONLY. TUYỆT ĐỐI KHÔNG ĐƯỢC CHỈNH SỬA, TẠO MỚI HAY XOÁ BẤT KỲ FILE CODE NÀO CỦA DỰ ÁN (Chỉ được ghi file đánh giá .team/REVIEW.md và REPORT.md).

Nhiệm vụ:
1. Soi toàn bộ các thay đổi qua 'git status' và 'git diff'.
2. Đối chiếu với '.team/PLAN.md', '.team/CODE_CHANGES.md' và '.team/TEST_RESULTS.md'.
3. Đánh giá chất lượng code:
   - Đúng yêu cầu và đúng checklist trong PLAN.md chưa?
   - Có code thừa, code phức tạp quá mức (over-engineering) không?
   - TESTER đã test đủ các trường hợp biên chưa?
4. Đưa ra PHÁN QUYẾT rõ ràng trong '.team/REVIEW.md':
   - Nếu ĐẠT: Ghi 'DECISION: APPROVED'.
   - Nếu CÒN LỖI/CHƯA ĐẠT: Ghi 'DECISION: CHANGES_REQUESTED' kèm danh sách chính xác các điểm cần CODER sửa lại.
5. Nếu APPROVED: Tổng kết thành file 'REPORT.md' hoàn chỉnh cho User (bao gồm: Kế hoạch, Thay đổi code, Kết quả test, Đánh giá review).

Khi hoàn tất, trả lời: 'Đã hoàn thành review. Phán quyết tại .team/REVIEW.md'.
`.trim() : (isLastCycle ? `
${AUTONOMOUS_RULES}

Bạn là Principal Code Reviewer (REVIEWER).
QUY TẮC BẮT BUỘC: Bạn ở CHẾ ĐỘ READ-ONLY. TUYỆT ĐỐI KHÔNG ĐƯỢC CHỈNH SỬA, TẠO MỚI HAY XOÁ BẤT KỲ FILE CODE NÀO CỦA DỰ ÁN (Chỉ được ghi file đánh giá .team/REVIEW.md và REPORT.md).

ĐẶC BIỆT: Đây là CHU KỲ CUỐI CÙNG (${cycle}/${totalLoops}) của chế độ xoay vòng tự động.

Nhiệm vụ:
1. Soi toàn bộ các thay đổi qua 'git status' và 'git diff'.
2. Đối chiếu với '.team/PLAN.md', '.team/CODE_CHANGES.md' và '.team/TEST_RESULTS.md'.
3. Đánh giá chất lượng mã nguồn tổng thể của toàn bộ quy trình:
   - Toàn bộ checklist các chu kỳ đã hoàn thành trọn vẹn chưa?
   - Kiểm thử đã bao quát đầy đủ cả happy path và edge cases chưa?
4. Đưa ra PHÁN QUYẾT VỀ MÃ NGUỒN trong '.team/REVIEW.md':
   - Nếu có lỗi cú pháp hoặc test fail nghiêm trọng: Ghi 'DECISION: CHANGES_REQUESTED' kèm danh sách điểm CODER cần sửa ngay.
   - Nếu code ổn: Ghi 'DECISION: APPROVED'.
5. Đưa ra CHỈ THỊ VÒNG LẶP CUỐI CÙNG ở cuối file '.team/REVIEW.md':
   - Vì đây là chu kỳ cuối cùng (${totalLoops}/${totalLoops}), hãy ghi: 'CYCLE_STATUS: ALL_GOALS_COMPLETED'.
6. Cập nhật và xuất bản file 'REPORT.md' hoàn chỉnh nhất, tổng kết toàn diện toàn bộ các chu kỳ đã thực hiện cho User.

Khi hoàn tất, trả lời: 'Đã hoàn thành review Chu kỳ cuối (${cycle}/${totalLoops}). Phán quyết tại .team/REVIEW.md'.
`.trim() : `
${AUTONOMOUS_RULES}

Bạn là Principal Code Reviewer (REVIEWER).
QUY TẮC BẮT BUỘC: Bạn ở CHẾ ĐỘ READ-ONLY. TUYỆT ĐỐI KHÔNG ĐƯỢC CHỈNH SỬA, TẠO MỚI HAY XOÁ BẤT KỲ FILE CODE NÀO CỦA DỰ ÁN (Chỉ được ghi file đánh giá .team/REVIEW.md và REPORT.md).

ĐẶC BIỆT: Hệ thống đang chạy ở CHẾ ĐỘ XOAY VÒNG TỰ ĐỘNG - ĐÂY LÀ CHU KỲ ${cycle}/${totalLoops}.
Người dùng đã yêu cầu thực hiện ĐỦ ${totalLoops} chu kỳ xoay vòng để liên tục cải tiến và nâng cao chất lượng dự án.

QUY TẮC BẮT BUỘC CHO CHU KỲ TRUNG GIAN (${cycle}/${totalLoops}):
- TUYỆT ĐỐI KHÔNG DỪNG SỚM. TUYỆT ĐỐI KHÔNG ghi 'CYCLE_STATUS: ALL_GOALS_COMPLETED' (chỉ chu kỳ cuối cùng ${totalLoops} mới được ghi).
- BẮT BUỘC ghi ở cuối '.team/REVIEW.md': 'CYCLE_STATUS: CONTINUE_NEXT_CYCLE'.

Nhiệm vụ:
1. Soi toàn bộ các thay đổi qua 'git status' và 'git diff' của Chu kỳ ${cycle}.
2. Đối chiếu với '.team/PLAN.md', '.team/CODE_CHANGES.md' và '.team/TEST_RESULTS.md'.
3. Đánh giá chất lượng code của chu kỳ này:
   - Nếu có lỗi cú pháp hoặc test fail nghiêm trọng: Ghi 'DECISION: CHANGES_REQUESTED' kèm danh sách điểm CODER cần sửa ngay.
   - Nếu code ổn: Ghi 'DECISION: APPROVED'.
4. BÁO CÁO THIẾU SÓT & ĐỀ XUẤT CẢI TIẾN CHO CHU KỲ TIẾP THEO (${cycle + 1}/${totalLoops}) trong '.team/REVIEW.md':
   - Dù các mục tiêu ban đầu của chu kỳ này đã hoàn thành, bạn BẮT BUỘC phải tìm ra các khía cạnh cần đào sâu, tối ưu hóa hoặc hoàn thiện thêm cho chu kỳ tiếp theo:
     + Các trường hợp biên (edge cases), góc khuất dữ liệu, kiểm thử tự động chuyên sâu.
     + Tối ưu hóa hiệu năng, giảm độ phức tạp mã nguồn (refactoring, clean code).
     + Nâng cao trải nghiệm người dùng, responsive, accessibility, trạng thái tải, xử lý lỗi mượt mà.
     + Các tính năng mở rộng có giá trị thực tiễn cho dự án.
   - Nêu danh sách đề xuất cụ thể này để PLANNER tiếp quản lập kế hoạch ở Chu kỳ ${cycle + 1}.
5. Đưa ra CHỈ THỊ VÒNG LẶP ở cuối file '.team/REVIEW.md':
   - BẮT BUỘC ghi: 'CYCLE_STATUS: CONTINUE_NEXT_CYCLE'.
6. Cập nhật file 'REPORT.md' ghi nhận tiến độ đạt được tới hết Chu kỳ ${cycle}.

Khi hoàn tất, trả lời: 'Đã hoàn thành review Chu kỳ ${cycle}/${totalLoops}. Phán quyết tại .team/REVIEW.md'.
`.trim());

    await promptAgent(roles.REVIEWER, reviewerPrompt);

    // Check if REVIEWER requested changes
    try {
      const reviewContent = await fs.readFile(path.join(TEAM_DIR, 'REVIEW.md'), 'utf8');
      if (reviewContent.includes('DECISION: CHANGES_REQUESTED')) {
        console.log(`\n⚠️ REVIEWER YÊU CẦU CHỈNH SỬA LỖI TRONG CHU KỲ ${cycle}! Đang chuyển cho CODER...`);

        const fixPrompt = `
${AUTONOMOUS_RULES}

REVIEWER đã kiểm tra mã nguồn và yêu cầu sửa lại một số vấn đề trong Chu kỳ ${cycle}.
Hãy đọc kỹ file '.team/REVIEW.md' để biết các lỗi cụ thể cần khắc phục.
Tiến hành sửa code theo đúng yêu cầu review, sau đó cập nhật lại '.team/CODE_CHANGES.md'.
Khi hoàn tất, trả lời: 'Đã sửa xong các lỗi theo yêu cầu của Reviewer'.
`.trim();

        await promptAgent(roles.CODER, fixPrompt);

        // Re-test and Re-review
        console.log('🔄 TESTER chạy lại kiểm thử...');
        const currentTesterPrompt = `
${AUTONOMOUS_RULES}

CODER đã sửa các lỗi theo yêu cầu của REVIEWER trong Chu kỳ ${cycle}.
Hãy chạy lại toàn bộ kiểm thử và cập nhật lại '.team/TEST_RESULTS.md'.
Khi hoàn tất, trả lời: 'Kiểm thử hoàn tất. Kết quả tại .team/TEST_RESULTS.md'.
`.trim();
        await promptAgent(roles.TESTER, currentTesterPrompt);

        console.log('🔍 REVIEWER chốt hạ bản review cuối cho chu kỳ này...');
        await promptAgent(roles.REVIEWER, reviewerPrompt);
      }
    } catch {}

    // In loop mode: manage cycle transitions without premature termination
    if (totalLoops > 1) {
      if (cycle < totalLoops) {
        console.log(`\n🔄 REVIEWER đã hoàn thành thẩm định Chu kỳ ${cycle}/${totalLoops}.`);
        console.log(`📋 Đề xuất nâng cấp & tối ưu hóa cho chu kỳ tiếp theo đã sẵn sàng trong .team/REVIEW.md.`);
        console.log(`⏩ TỰ ĐỘNG CHUYỂN GIAO SANG CHU KỲ ${cycle + 1}/${totalLoops} CHO PLANNER (Thực hiện đúng ${totalLoops} chu kỳ theo yêu cầu)...\n`);
      } else {
        console.log(`\n🏁 ĐÃ HOÀN THÀNH TOÀN BỘ SỐ CHU KỲ ĐƯỢC YÊU CẦU (${totalLoops}/${totalLoops} chu kỳ).`);
      }
    }
  }

  const totalSec = ((Date.now() - totalStart) / 1000).toFixed(1);

  console.log('\n============================================================');
  console.log(`🎉 QUY TRÌNH ĐỘI NGŨ HOÀN THÀNH XUẤT SẮC TRONG ${totalSec}s!`);
  console.log('📄 Kế hoạch kỹ thuật:   .team/PLAN.md');
  console.log('💻 Mã nguồn thay đổi:   .team/CODE_CHANGES.md');
  console.log('🧪 Kết quả kiểm thử:    .team/TEST_RESULTS.md');
  console.log('🔍 Đánh giá Review:     .team/REVIEW.md');
  console.log('📋 Báo cáo tổng kết:    REPORT.md');
  console.log('============================================================\n');
}

// --- CLI Entrypoint ---

async function main() {
  const isHerdrRunning = await ensureHerdrServer();
  if (!isHerdrRunning) {
    console.error('❌ Không thể khởi động Herdr server. Hãy thử mở lại terminal.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Herdr Multi-Agent Team Runner (4 Roles: PLANNER, CODER, TESTER, REVIEWER)

Cú pháp:
  team "Mô tả nhiệm vụ cần làm" [tuỳ chọn]

Các tuỳ chọn:
  -InitOnly, --init-only       Hiện menu chọn Model (OpenCode/Antigravity), Chế độ và Số vòng lặp
  -Loop, --loop                Chạy ở chế độ xoay vòng tự động
  -Once, --once                Chạy ở chế độ tiêu chuẩn (1 lượt)
  -MaxLoops <N>, --max-loops <N>  Số vòng lặp tối đa (mặc định: 3, sẽ tự động bật chế độ loop)
  -Planner <opencode|agy>      Chỉ định model cho PLANNER
  -Coder <opencode|agy>        Chỉ định model cho CODER
  -Resume, --resume            Tiếp tục chạy thẳng từ bước CODER (bỏ qua PLANNER)
  -From <planner|coder|tester|reviewer>  Bắt đầu chạy từ một vai trò cụ thể

Ví dụ:
  team "Hoàn thiện hệ thống xác thực và viết unit test" -Loop -MaxLoops 3
  team "Tối ưu hóa performance và refactor API" -MaxLoops 3
  team -InitOnly
`);
    process.exit(0);
  }
  const isInitOnly = args.includes('--init-only') || args.includes('-i');

  // Check if planner was passed as CLI argument
  let plannerArg = null;
  const plannerIndex = args.findIndex((a) => a === '--planner' || a === '-planner');
  if (plannerIndex !== -1 && args[plannerIndex + 1]) {
    plannerArg = args[plannerIndex + 1].toLowerCase();
    if (plannerArg === 'antigravity') plannerArg = 'agy';
  }

  // Check if coder was passed as CLI argument
  let coderArg = null;
  const coderIndex = args.findIndex((a) => a === '--coder' || a === '-coder');
  if (coderIndex !== -1 && args[coderIndex + 1]) {
    coderArg = args[coderIndex + 1].toLowerCase();
    if (coderArg === 'antigravity') coderArg = 'agy';
  }

  // Check if mode was passed as CLI argument
  let modeArg = null;
  if (args.includes('--loop') || args.includes('-loop')) {
    modeArg = 'loop';
  } else if (args.includes('--once') || args.includes('-once')) {
    modeArg = 'once';
  }
  const modeIndex = args.findIndex((a) => a === '--mode' || a === '-mode');
  if (modeIndex !== -1 && args[modeIndex + 1]) {
    modeArg = args[modeIndex + 1].toLowerCase();
  }

  // Check if max-loops was passed as CLI argument
  let maxLoopsArg = null;
  const maxLoopsIndex = args.findIndex((a) => a === '--max-loops' || a === '-max-loops');
  if (maxLoopsIndex !== -1 && args[maxLoopsIndex + 1]) {
    const parsedLoops = parseInt(args[maxLoopsIndex + 1], 10);
    if (!isNaN(parsedLoops) && parsedLoops > 0) {
      maxLoopsArg = parsedLoops;
    }
  }

  // If user specified --max-loops > 1 without explicit --once, default mode to 'loop'
  if (maxLoopsArg && maxLoopsArg > 1 && !modeArg) {
    modeArg = 'loop';
  }

  // Check if start stage was passed (resume / from)
  let startStage = 'planner';
  const fromIndex = args.findIndex((a) => a === '--from' || a === '-from');
  if (fromIndex !== -1 && args[fromIndex + 1]) {
    startStage = args[fromIndex + 1].toLowerCase();
  } else if (args.includes('--resume') || args.includes('-resume')) {
    startStage = 'coder';
  }

  const taskArgs = args.filter((a, idx) => {
    if (a === '--init-only' || a === '-i') return false;
    if (a === '--resume' || a === '-resume') return false;
    if (a === '--planner' || a === '-planner') return false;
    if (idx > 0 && (args[idx - 1] === '--planner' || args[idx - 1] === '-planner')) return false;
    if (a === '--coder' || a === '-coder') return false;
    if (idx > 0 && (args[idx - 1] === '--coder' || args[idx - 1] === '-coder')) return false;
    if (a === '--from' || a === '-from') return false;
    if (idx > 0 && (args[idx - 1] === '--from' || args[idx - 1] === '-from')) return false;
    if (a === '--loop' || a === '-loop') return false;
    if (a === '--once' || a === '-once') return false;
    if (a === '--mode' || a === '-mode') return false;
    if (idx > 0 && (args[idx - 1] === '--mode' || args[idx - 1] === '-mode')) return false;
    if (a === '--max-loops' || a === '-max-loops') return false;
    if (idx > 0 && (args[idx - 1] === '--max-loops' || args[idx - 1] === '-max-loops')) return false;
    return true;
  });
  const task = taskArgs.join(' ').trim();

  // Load saved choices if exist
  let savedPlanner = 'opencode';
  let savedCoder = 'opencode';
  let savedMode = 'once';
  let savedMaxLoops = 3;
  let hasConfigFile = false;

  try {
    const raw = await fs.readFile(TEAM_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.planner) savedPlanner = parsed.planner;
    if (parsed.coder) savedCoder = parsed.coder;
    if (parsed.mode) savedMode = parsed.mode;
    if (parsed.maxLoops) savedMaxLoops = parseInt(parsed.maxLoops, 10) || 3;
    hasConfigFile = true;
  } catch {
    try {
      const rawLegacy = await fs.readFile(LEGACY_CODER_CONFIG_FILE, 'utf8');
      const parsedLegacy = JSON.parse(rawLegacy);
      if (parsedLegacy.coder) savedCoder = parsedLegacy.coder;
    } catch {}
  }

  let chosenPlanner = plannerArg;
  let chosenCoder = coderArg;
  let chosenMode = modeArg;
  let chosenMaxLoops = maxLoopsArg;

  // Prompt arrow-key menu if running with -InitOnly OR if no config exists yet and no CLI args provided
  if (isInitOnly || (!hasConfigFile && !chosenPlanner && !chosenCoder && !chosenMode && !chosenMaxLoops)) {
    if (!chosenPlanner) {
      chosenPlanner = await selectModelInteractive('PLANNER (Lập Kế Hoạch & Đặc Tả)', savedPlanner);
    }
    if (!chosenCoder) {
      chosenCoder = await selectModelInteractive('CODER (Viết Code & Sửa Bug)', savedCoder);
    }
    if (!chosenMode) {
      chosenMode = await selectModeInteractive(savedMode);
    }
    if (chosenMode === 'loop' && !chosenMaxLoops) {
      chosenMaxLoops = await selectMaxLoopsInteractive(savedMaxLoops);
    } else if (!chosenMaxLoops) {
      chosenMaxLoops = savedMaxLoops;
    }

    await fs.mkdir(TEAM_DIR, { recursive: true });
    await fs.writeFile(
      TEAM_CONFIG_FILE,
      JSON.stringify({
        planner: chosenPlanner,
        coder: chosenCoder,
        mode: chosenMode,
        maxLoops: chosenMaxLoops
      }, null, 2)
    );
  } else {
    if (!chosenPlanner) chosenPlanner = savedPlanner;
    if (!chosenCoder) chosenCoder = savedCoder;
    if (!chosenMode) chosenMode = savedMode || 'once';
    if (!chosenMaxLoops) chosenMaxLoops = savedMaxLoops || 3;

    // Persist config if CLI arguments were passed or if no config file existed yet
    if (!hasConfigFile || plannerArg || coderArg || modeArg || maxLoopsArg) {
      await fs.mkdir(TEAM_DIR, { recursive: true });
      await fs.writeFile(
        TEAM_CONFIG_FILE,
        JSON.stringify({
          planner: chosenPlanner,
          coder: chosenCoder,
          mode: chosenMode,
          maxLoops: chosenMaxLoops
        }, null, 2)
      );
    }
  }

  // Setup workspace & 4 agents on Herdr
  const roles = await ensureWorkspaceAndAgents(chosenPlanner, chosenCoder);

  if (isInitOnly || (!task && startStage === 'planner')) {
    if (!task && !isInitOnly) {
      console.log('💡 Gợi ý: Để giao việc cho đội ngũ tự động thực hiện, hãy chạy:');
      console.log('   team "Mô tả nhiệm vụ cần làm..."\n');
    }
    console.log('✨ 4 Agent đã sẵn sàng trên Herdr. Bạn có thể sử dụng giao diện Herdr hoặc chạy lệnh giao việc bất kỳ lúc nào.');
    return;
  }

  await runTaskPipeline(task, roles, startStage, chosenMode, chosenMaxLoops);
}

main().catch((err) => {
  console.error('\n❌ Lỗi trong quá trình điều phối:', err);
  process.exit(1);
});
