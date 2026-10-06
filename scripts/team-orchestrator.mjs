#!/usr/bin/env node
/**
 * Herdr Multi-Agent Team Orchestrator (Universal / Spec-Driven Edition)
 *
 * 4 Specialised Roles:
 * 1. PLANNER (OpenCode): Biến yêu cầu sơ sài thành đặc tả kỹ thuật chi tiết (.team/PLAN.md)
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
const CODER_CONFIG_FILE = path.join(TEAM_DIR, 'coder_config.json');

function normalizePath(p) {
  if (!p) return '';
  return path.resolve(p).toLowerCase().replace(/\\/g, '/');
}

function getProjectPrefix() {
  const base = path.basename(ROOT_DIR).toLowerCase().replace(/[^a-z0-9]/g, '_');
  return base.slice(0, 10).replace(/_+$/, '') || 'team';
}

// --- Interactive Selection for CODER (Arrow Keys + Enter) ---

async function selectCoderModelInteractive(defaultChoice = 'opencode') {
  if (!process.stdin.isTTY) {
    return defaultChoice;
  }

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

  let selectedIndex = options.findIndex((o) => o.id === defaultChoice);
  if (selectedIndex === -1) selectedIndex = 0;

  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const render = (firstTime = false) => {
      if (!firstTime) {
        readline.moveCursor(process.stdout, 0, -(options.length + 3));
      }
      console.log('\n┌────────────────────────────────────────────────────────────┐');
      console.log('│ 🤖 CHỌN MODEL CHO VAI TRÒ CODER (Dùng phím ↑ / ↓, bấm Enter) │');
      console.log('└────────────────────────────────────────────────────────────┘');

      options.forEach((opt, idx) => {
        const isSelected = idx === selectedIndex;
        const pointer = isSelected ? '\x1b[36m❯ [•]\x1b[0m' : '   [ ]';
        const title = isSelected ? `\x1b[1m\x1b[36m${opt.name}\x1b[0m` : opt.name;
        console.log(`${pointer} ${title.padEnd(16)} - ${opt.desc}`);
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
        console.log(`\n🎯 Đã chọn CODER: \x1b[32m\x1b[1m${chosen.name}\x1b[0m\n`);
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

async function ensureWorkspaceAndAgents(chosenCoderKind) {
  console.log(`🔍 Đang kiểm tra không gian làm việc Herdr cho: "${ROOT_DIR}"...`);

  const currentNorm = normalizePath(ROOT_DIR);
  const workspaces = await getWorkspaces();
  let targetWs = workspaces.find((w) => {
    const checkPath = w.worktree?.checkout_path || w.cwd;
    return normalizePath(checkPath) === currentNorm;
  });

  const prefix = getProjectPrefix();
  const rolePlanner = `${prefix}_planner`;
  const roleCoder = `${prefix}_coder`;
  const roleTester = `${prefix}_tester`;
  const roleReviewer = `${prefix}_reviewer`;

  const activeRoles = {
    PLANNER: rolePlanner,
    CODER: roleCoder,
    TESTER: roleTester,
    REVIEWER: roleReviewer,
    CODER_KIND: chosenCoderKind
  };

  const liveAgents = await getLiveAgents();
  const agentByName = {};
  for (const a of liveAgents) {
    if (a.name) agentByName[a.name] = a;
  }

  // Check if all 4 agents are already running with matching roles and CWD
  const plannerReady = agentByName[rolePlanner] && normalizePath(agentByName[rolePlanner].cwd) === currentNorm;
  const coderReady =
    agentByName[roleCoder] &&
    normalizePath(agentByName[roleCoder].cwd) === currentNorm &&
    agentByName[roleCoder].agent === chosenCoderKind;
  const testerReady = agentByName[roleTester] && normalizePath(agentByName[roleTester].cwd) === currentNorm;
  const reviewerReady = agentByName[roleReviewer] && normalizePath(agentByName[roleReviewer].cwd) === currentNorm;

  if (plannerReady && coderReady && testerReady && reviewerReady) {
    console.log('✅ Đã tìm thấy đầy đủ 4 AI Agent sẵn sàng trong project:');
    console.log(`   - [PLANNER]  ${rolePlanner} (OpenCode)`);
    console.log(`   - [CODER]    ${roleCoder} (${chosenCoderKind === 'agy' ? 'Antigravity' : 'OpenCode'})`);
    console.log(`   - [TESTER]   ${roleTester} (Antigravity)`);
    console.log(`   - [REVIEWER] ${roleReviewer} (Antigravity - Read-Only)`);
    return activeRoles;
  }

  // If no workspace exists for this project, create a new 2x2 workspace
  if (!targetWs) {
    const projectName = path.basename(ROOT_DIR);
    console.log(`📁 Tạo workspace mới trên Herdr: "${projectName}"...`);
    const wsRes = await runHerdrJson([
      'workspace',
      'create',
      '--label',
      projectName,
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

    // 1. PLANNER: OpenCode (--auto)
    console.log(`🚀 [1/4] Khởi động PLANNER: ${rolePlanner} (OpenCode --auto)...`);
    await runHerdr(['agent', 'start', rolePlanner, '--kind', 'opencode', '--pane', rootPaneId, '--', '--auto']);

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
    // Existing workspace: ensure roles mapped or replaced
    const callersPane = process.env.HERDR_PANE_ID;
    const currentAgents = await getLiveAgents();
    const wsAgents = currentAgents.filter((a) => a.workspace_id === targetWs.workspace_id);

    // Map PLANNER
    if (!plannerReady) {
      const pCandidate = wsAgents.find((a) => a.agent === 'opencode' && (!a.name || a.name.includes('leader') || a.name.includes('planner')));
      if (pCandidate) {
        console.log(`🏷️  Gán pane ${pCandidate.pane_id} thành PLANNER (${rolePlanner})...`);
        await runHerdr(['agent', 'rename', pCandidate.pane_id, rolePlanner]);
      }
    }

    // Map or replace CODER
    if (!coderReady) {
      const cCandidate = wsAgents.find((a) => a.name && (a.name.includes('backend') || a.name.includes('coder')));
      if (cCandidate && cCandidate.agent === chosenCoderKind) {
        console.log(`🏷️  Gán pane ${cCandidate.pane_id} thành CODER (${roleCoder})...`);
        await runHerdr(['agent', 'rename', cCandidate.pane_id, roleCoder]);
      } else {
        // If candidate has different model, restart it in that pane
        const targetPane = cCandidate?.pane_id || wsAgents[1]?.pane_id;
        if (targetPane) {
          console.log(`🔄 Chuyển đổi CODER tại pane ${targetPane} sang ${chosenCoderKind === 'agy' ? 'Antigravity' : 'OpenCode'}...`);
          try {
            await runHerdr(['agent', 'send-keys', targetPane, 'ctrl+c']);
            await delay(1000);
          } catch {}
          const coderArgs = chosenCoderKind === 'agy' ? ['--', '--dangerously-skip-permissions'] : ['--', '--auto'];
          await runHerdr(['agent', 'start', roleCoder, '--kind', chosenCoderKind, '--pane', targetPane, ...coderArgs]);
          await waitForAgentIdle(roleCoder, 45000);
        }
      }
    }

    // Map TESTER
    if (!testerReady) {
      const tCandidate = wsAgents.find((a) => a.agent === 'agy' && a.pane_id !== callersPane && (!a.name || a.name.includes('tester')));
      if (tCandidate) {
        console.log(`🏷️  Gán pane ${tCandidate.pane_id} thành TESTER (${roleTester})...`);
        await runHerdr(['agent', 'rename', tCandidate.pane_id, roleTester]);
      }
    }

    // Map REVIEWER
    if (!reviewerReady) {
      const rCandidate = wsAgents.find((a) => a.agent === 'agy' && a.pane_id !== callersPane && a.name !== roleTester);
      if (rCandidate) {
        console.log(`🏷️  Gán pane ${rCandidate.pane_id} thành REVIEWER (${roleReviewer})...`);
        await runHerdr(['agent', 'rename', rCandidate.pane_id, roleReviewer]);
      }
    }
  }

  console.log('\n🎉 Đội ngũ 4 AI Agents đã sẵn sàng:');
  console.log(`   1. [PLANNER]  ${activeRoles.PLANNER} (OpenCode)`);
  console.log(`   2. [CODER]    ${activeRoles.CODER} (${chosenCoderKind === 'agy' ? 'Antigravity' : 'OpenCode'})`);
  console.log(`   3. [TESTER]   ${activeRoles.TESTER} (Antigravity)`);
  console.log(`   4. [REVIEWER] ${activeRoles.REVIEWER} (Antigravity - Read-Only)\n`);

  return activeRoles;
}

// --- Prompt & Execute ---

async function promptAgent(target, promptText, timeoutMs = 600000) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`▶ GIAO VIỆC CHO: [${target.toUpperCase()}]`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  const startTime = Date.now();

  try {
    try {
      await runHerdr(['agent', 'focus', target]);
    } catch {}

    await runHerdrJson([
      'agent',
      'prompt',
      target,
      promptText,
      '--wait',
      '--timeout',
      String(timeoutMs)
    ]);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✔ [${target.toUpperCase()}] Hoàn thành công việc trong ${elapsed}s.`);
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`✖ [${target.toUpperCase()}] Thất bại hoặc hết thời gian (${elapsed}s): ${err.message}`);
    throw err;
  }
}

// --- Main 4-Role Task Execution Pipeline ---

async function runTaskPipeline(taskDescription, roles) {
  console.log('\n============================================================');
  console.log('🤖 BẮT ĐẦU QUY TRÌNH 4 BƯỚC ĐỘI NGŨ AI TỰ ĐỘNG');
  console.log(`📁 Thư mục dự án: ${ROOT_DIR}`);
  console.log(`📋 Nhiệm vụ: "${taskDescription}"`);
  console.log(`⚙️  CODER sử dụng: ${roles.CODER_KIND === 'agy' ? 'Antigravity' : 'OpenCode'}`);
  console.log('============================================================');

  await fs.mkdir(TEAM_DIR, { recursive: true });

  const totalStart = Date.now();

  // STAGE 1: PLANNER
  const plannerPrompt = `
[YÊU CẦU TỪ NGƯỜI DÙNG]:
${taskDescription}

Bạn là Lead Architect kiêm Product Planner (PLANNER).
Nhiệm vụ tối quan trọng: Biến yêu cầu trên (có thể còn sơ sài) thành một BẢN ĐẶC TẢ KỸ THUẬT VÀ KẾ HOẠCH CHI TIẾT CHUẨN CHỈ. Kế hoạch càng chuẩn xác thì các bước sau mới thực hiện tốt.

Hãy khảo sát codebase hiện tại và ghi toàn bộ vào file '.team/PLAN.md' bao gồm:
1. Phân tích chi tiết yêu cầu & mục tiêu cốt lõi (User Intent & Scope).
2. Danh sách các file cần tác động (tạo mới, sửa, xóa) và đường dẫn chính xác.
3. Đặc tả chi tiết giải pháp kỹ thuật (functions, types, logic xử lý, API payload/response nếu có).
4. Danh sách các trường hợp ngoại lệ, rủi ro và ca biên (Edge cases & Boundary conditions) cần lưu ý.
5. Checklist công việc từng bước (Step-by-step tasks với checkbox) cho CODER thực hiện.
6. Yêu cầu kiểm thử cho TESTER.

Khi hoàn thành, trả lời: 'Kế hoạch kỹ thuật đã sẵn sàng tại .team/PLAN.md'.
`.trim();

  await promptAgent(roles.PLANNER, plannerPrompt, 600000);

  // STAGE 2: CODER
  const coderPrompt = `
Bạn là Senior Software Engineer (CODER). Model: ${roles.CODER_KIND === 'agy' ? 'Antigravity' : 'OpenCode'}.
Nhiệm vụ: Đọc kỹ bản đặc tả kỹ thuật và kế hoạch tại '.team/PLAN.md' do PLANNER lập ra.
1. Tiến hành viết code, chỉnh sửa, thêm, xóa các file theo đúng checklist trong PLAN.md.
2. Tuân thủ Karpathy Guidelines: Không suy đoán, code tối giản, thay đổi chính xác có mục tiêu (surgical changes), không sửa code ngoài phạm vi.
3. Xử lý triệt để các trường hợp biên và ngoại lệ mà PLANNER đã cảnh báo.
4. Ghi chép tóm tắt toàn bộ thay đổi mã nguồn vào file '.team/CODE_CHANGES.md' (file nào đã sửa, logic gì đã thêm, lý do).

Khi hoàn tất, trả lời: 'Code đã hoàn thành. Chi tiết tại .team/CODE_CHANGES.md'.
`.trim();

  await promptAgent(roles.CODER, coderPrompt, 900000);

  // STAGE 3: TESTER
  const testerPrompt = `
Bạn là QA & Testing Engineer (TESTER).
Nhiệm vụ: Đọc '.team/PLAN.md' và các thay đổi code tại '.team/CODE_CHANGES.md'.
1. Tự phân tích logic code mới viết, suy luận các kịch bản kiểm thử:
   - Happy path (tính năng chạy bình thường).
   - Edge cases & Corner cases (dữ liệu rỗng, dữ liệu sai định dạng, timeout, ranh giới mốc số liệu,...).
2. Tự viết test cases hoặc bổ sung unit/integration tests nếu dự án có test framework.
3. Chạy kiểm thử thực tế trong terminal (ví dụ: npm test, npm run build, npm run lint,... nếu có).
4. Ghi toàn bộ kết quả kiểm thử, các test case đã chạy và các lỗi phát hiện (nếu có) vào '.team/TEST_RESULTS.md'.

Khi hoàn tất, trả lời: 'Kiểm thử hoàn tất. Kết quả tại .team/TEST_RESULTS.md'.
`.trim();

  await promptAgent(roles.TESTER, testerPrompt, 600000);

  // STAGE 4: REVIEWER (READ-ONLY)
  const reviewerPrompt = `
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
`.trim();

  await promptAgent(roles.REVIEWER, reviewerPrompt, 600000);

  // Check if REVIEWER requested changes
  try {
    const reviewContent = await fs.readFile(path.join(TEAM_DIR, 'REVIEW.md'), 'utf8');
    if (reviewContent.includes('DECISION: CHANGES_REQUESTED')) {
      console.log('\n⚠️ REVIEWER YÊU CẦU CHỈNH SỬA LỖI! Đang chuyển phản hồi cho CODER...');

      const fixPrompt = `
REVIEWER đã kiểm tra mã nguồn và yêu cầu sửa lại một số vấn đề.
Hãy đọc kỹ file '.team/REVIEW.md' để biết các lỗi cụ thể cần khắc phục.
Tiến hành sửa code theo đúng yêu cầu review, sau đó cập nhật lại '.team/CODE_CHANGES.md'.
Khi hoàn tất, trả lời: 'Đã sửa xong các lỗi theo yêu cầu của Reviewer'.
`.trim();

      await promptAgent(roles.CODER, fixPrompt, 600000);

      // Re-test and Re-review
      console.log('🔄 TESTER chạy lại kiểm thử...');
      await promptAgent(roles.TESTER, testerPrompt, 400000);

      console.log('🔍 REVIEWER chốt hạ bản review cuối...');
      await promptAgent(roles.REVIEWER, reviewerPrompt, 400000);
    }
  } catch {}

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
  const isInitOnly = args.includes('--init-only') || args.includes('-i');

  // Check if coder was passed as CLI argument
  let coderArg = null;
  const coderIndex = args.findIndex((a) => a === '--coder' || a === '-coder');
  if (coderIndex !== -1 && args[coderIndex + 1]) {
    coderArg = args[coderIndex + 1].toLowerCase();
    if (coderArg === 'antigravity') coderArg = 'agy';
  }

  const taskArgs = args.filter((a, idx) => {
    if (a === '--init-only' || a === '-i') return false;
    if (a === '--coder' || a === '-coder') return false;
    if (idx > 0 && (args[idx - 1] === '--coder' || args[idx - 1] === '-coder')) return false;
    return true;
  });
  const task = taskArgs.join(' ').trim();

  // Load saved coder choice if exists
  let savedCoder = 'opencode';
  try {
    const raw = await fs.readFile(CODER_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.coder) savedCoder = parsed.coder;
  } catch {}

  let chosenCoder = coderArg;

  // Prompt arrow-key menu if running with -InitOnly OR if no coder choice was passed
  if (!chosenCoder && (isInitOnly || !savedCoder)) {
    chosenCoder = await selectCoderModelInteractive(savedCoder);
    await fs.mkdir(TEAM_DIR, { recursive: true });
    await fs.writeFile(CODER_CONFIG_FILE, JSON.stringify({ coder: chosenCoder }, null, 2));
  } else if (!chosenCoder) {
    chosenCoder = savedCoder;
  }

  // Setup workspace & 4 agents on Herdr
  const roles = await ensureWorkspaceAndAgents(chosenCoder);

  if (isInitOnly || !task) {
    if (!task && !isInitOnly) {
      console.log('💡 Gợi ý: Để giao việc cho đội ngũ tự động thực hiện, hãy chạy:');
      console.log('   team "Mô tả nhiệm vụ cần làm..."\n');
    }
    console.log('✨ 4 Agent đã sẵn sàng trên Herdr. Bạn có thể sử dụng giao diện Herdr hoặc chạy lệnh giao việc bất kỳ lúc nào.');
    return;
  }

  await runTaskPipeline(task, roles);
}

main().catch((err) => {
  console.error('\n❌ Lỗi trong quá trình điều phối:', err);
  process.exit(1);
});
