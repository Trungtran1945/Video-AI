#!/usr/bin/env node
/**
 * Herdr Multi-Agent Team Orchestrator (Universal / Global Edition)
 * Automatically sets up and coordinates OpenCode and Antigravity into a 4-agent development team
 * in ANY project directory on your machine.
 *
 * Roles:
 * 1. Leader (OpenCode): Codebase exploration, PLAN.md, and final executive REPORT.md
 * 2. Backend (OpenCode): Backend logic, API endpoints, bug fixes
 * 3. Frontend (Antigravity): UI, Components, styling, client-side API integration
 * 4. Tester (Antigravity): Regression testing, build & lint verification, QA report
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const ROOT_DIR = process.cwd();
const TEAM_DIR = path.join(ROOT_DIR, '.team');

function normalizePath(p) {
  if (!p) return '';
  return path.resolve(p).toLowerCase().replace(/\\/g, '/');
}

// Generate project-safe prefix for unique agent names (max 12 alphanumeric chars)
function getProjectPrefix() {
  const base = path.basename(ROOT_DIR).toLowerCase().replace(/[^a-z0-9]/g, '_');
  return base.slice(0, 12).replace(/_+$/, '') || 'team';
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
    const { spawn } = await import('node:child_process');
    const child = spawn('herdr', ['server'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();

    for (let i = 0; i < 10; i++) {
      await delay(500);
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

// --- Dynamic Role Identification & Setup ---

async function ensureWorkspaceAndAgents() {
  console.log(`🔍 Đang kiểm tra không gian làm việc Herdr cho: "${ROOT_DIR}"...`);

  const currentNorm = normalizePath(ROOT_DIR);
  const workspaces = await getWorkspaces();
  let targetWs = workspaces.find((w) => {
    const checkPath = w.worktree?.checkout_path || w.cwd;
    return normalizePath(checkPath) === currentNorm;
  });

  const prefix = getProjectPrefix();
  let roleLeader = 'opencode_leader';
  let roleBackend = 'opencode_backend';
  let roleFrontend = 'antigravity_frontend';
  let roleTester = 'antigravity_tester';

  const liveAgents = await getLiveAgents();
  const agentByName = {};
  for (const a of liveAgents) {
    if (a.name) agentByName[a.name] = a;
  }

  // If generic names are already taken by another directory, use project-prefixed names
  if (agentByName[roleLeader] && normalizePath(agentByName[roleLeader].cwd) !== currentNorm) {
    roleLeader = `${prefix}_leader`;
  }
  if (agentByName[roleBackend] && normalizePath(agentByName[roleBackend].cwd) !== currentNorm) {
    roleBackend = `${prefix}_backend`;
  }
  if (agentByName[roleFrontend] && normalizePath(agentByName[roleFrontend].cwd) !== currentNorm) {
    roleFrontend = `${prefix}_frontend`;
  }
  if (agentByName[roleTester] && normalizePath(agentByName[roleTester].cwd) !== currentNorm) {
    roleTester = `${prefix}_tester`;
  }

  const activeRoles = {
    LEADER: roleLeader,
    BACKEND: roleBackend,
    FRONTEND: roleFrontend,
    TESTER: roleTester
  };

  // Check if all 4 agents are already running in this project
  const allReady = Object.values(activeRoles).every((r) => {
    const a = agentByName[r];
    return a && normalizePath(a.cwd) === currentNorm;
  });

  if (allReady) {
    console.log('✅ Đã tìm thấy đầy đủ 4 AI Agent sẵn sàng trong project:');
    for (const [key, name] of Object.entries(activeRoles)) {
      console.log(`   - [${key}] ${name} (Status: ${agentByName[name]?.agent_status || 'idle'})`);
    }
    return activeRoles;
  }

  // If no workspace exists for this project, create a new one
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

    // Split 1: Root split right -> pBackend
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
    const pBackendId = splitRightRes?.result?.pane?.pane_id;

    // Split 2: Root split down -> pFrontend
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
    const pFrontendId = splitDown1?.result?.pane?.pane_id;

    // Split 3: pBackend split down -> pTester
    const splitDown2 = await runHerdrJson([
      'pane',
      'split',
      '--pane',
      pBackendId,
      '--direction',
      'down',
      '--cwd',
      ROOT_DIR,
      '--no-focus'
    ]);
    const pTesterId = splitDown2?.result?.pane?.pane_id;

    // Start all 4 agents
    console.log(`🚀 [1/4] Khởi động ${roleLeader} (OpenCode --auto)...`);
    await runHerdr(['agent', 'start', roleLeader, '--kind', 'opencode', '--pane', rootPaneId, '--', '--auto']);

    console.log(`🚀 [2/4] Khởi động ${roleBackend} (OpenCode --auto)...`);
    await runHerdr(['agent', 'start', roleBackend, '--kind', 'opencode', '--pane', pBackendId, '--', '--auto']);

    console.log(`🚀 [3/4] Khởi động ${roleFrontend} (Antigravity --dangerously-skip-permissions)...`);
    await runHerdr(['agent', 'start', roleFrontend, '--kind', 'agy', '--pane', pFrontendId, '--', '--dangerously-skip-permissions']);

    console.log(`🚀 [4/4] Khởi động ${roleTester} (Antigravity --dangerously-skip-permissions)...`);
    await runHerdr(['agent', 'start', roleTester, '--kind', 'agy', '--pane', pTesterId, '--', '--dangerously-skip-permissions']);

    console.log('⏳ Đợi các AI hoàn tất khởi động...');
    await Promise.all([
      waitForAgentIdle(roleLeader, 45000),
      waitForAgentIdle(roleBackend, 45000),
      waitForAgentIdle(roleFrontend, 45000),
      waitForAgentIdle(roleTester, 45000)
    ]);
  } else {
    // Workspace exists: rename or launch missing agents
    const wsPanes = await getPanes(targetWs.workspace_id);
    const callersPane = process.env.HERDR_PANE_ID;

    // Filter agents in this workspace
    const currentAgents = await getLiveAgents();
    const wsAgents = currentAgents.filter((a) => a.workspace_id === targetWs.workspace_id);

    const unnamedOpencode = wsAgents.filter((a) => a.agent === 'opencode' && !a.name);
    const unnamedAgy = wsAgents.filter((a) => a.agent === 'agy' && !a.name && a.pane_id !== callersPane);

    if (!agentByName[roleLeader] && unnamedOpencode.length > 0) {
      const a = unnamedOpencode.shift();
      console.log(`🏷️  Gán pane ${a.pane_id} thành ${roleLeader}...`);
      await runHerdr(['agent', 'rename', a.pane_id, roleLeader]);
      activeRoles.LEADER = roleLeader;
    }
    if (!agentByName[roleBackend] && unnamedOpencode.length > 0) {
      const a = unnamedOpencode.shift();
      console.log(`🏷️  Gán pane ${a.pane_id} thành ${roleBackend}...`);
      await runHerdr(['agent', 'rename', a.pane_id, roleBackend]);
      activeRoles.BACKEND = roleBackend;
    }
    if (!agentByName[roleFrontend] && unnamedAgy.length > 0) {
      const a = unnamedAgy.shift();
      console.log(`🏷️  Gán pane ${a.pane_id} thành ${roleFrontend}...`);
      await runHerdr(['agent', 'rename', a.pane_id, roleFrontend]);
      activeRoles.FRONTEND = roleFrontend;
    }
    if (!agentByName[roleTester] && unnamedAgy.length > 0) {
      const a = unnamedAgy.shift();
      console.log(`🏷️  Gán pane ${a.pane_id} thành ${roleTester}...`);
      await runHerdr(['agent', 'rename', a.pane_id, roleTester]);
      activeRoles.TESTER = roleTester;
    }
  }

  console.log('\n🎉 Đội ngũ 4 AI Agents đã sẵn sàng:');
  console.log(`   1. ${activeRoles.LEADER} (OpenCode - Leader/Planner)`);
  console.log(`   2. ${activeRoles.BACKEND} (OpenCode - Backend Engineer)`);
  console.log(`   3. ${activeRoles.FRONTEND} (Antigravity - Frontend Engineer)`);
  console.log(`   4. ${activeRoles.TESTER} (Antigravity - QA/Tester)\n`);

  return activeRoles;
}

// --- Prompt Pipeline ---

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

// --- Main Task Execution Pipeline ---

async function runTaskPipeline(taskDescription, roles) {
  console.log('\n============================================================');
  console.log('🤖 BẮT ĐẦU QUY TRÌNH PHỐI HỢP ĐỘI NGŨ AI TỰ ĐỘNG');
  console.log(`📁 Thư mục dự án: ${ROOT_DIR}`);
  console.log(`📋 Nhiệm vụ: "${taskDescription}"`);
  console.log('============================================================');

  await fs.mkdir(TEAM_DIR, { recursive: true });

  const totalStart = Date.now();

  // STAGE 1: LEADER PLANNING
  const leaderPrompt = `
[NHIỆM VỤ DỰ ÁN]:
${taskDescription}

Bạn là Lead Architect kiêm Project Manager.
Hãy khảo sát codebase hiện tại và lập kế hoạch thực hiện chi tiết cho các thành viên trong đội ngũ:
1. Phân tích yêu cầu và xác định phạm vi cần thay đổi.
2. Phần việc Backend: Liệt kê cụ thể file API, service, database, hoặc logic cần sửa/thêm.
3. Phần việc Frontend: Liệt kê cụ thể component, trang giao diện, style, và API endpoints cần tích hợp.
4. Phần việc QA / Tester: Các kịch bản test (backend tests, frontend build & lint).
5. Ghi toàn bộ kế hoạch vào file '.team/PLAN.md' (định dạng Markdown rõ ràng, có checkbox từng việc).
Khi hoàn thành, hãy trả lời: 'Kế hoạch đã sẵn sàng tại .team/PLAN.md'.
`.trim();

  await promptAgent(roles.LEADER, leaderPrompt, 600000);

  // STAGE 2: BACKEND IMPLEMENTATION
  const backendPrompt = `
Bạn là Backend Engineer.
Nhiệm vụ: Đọc kỹ file '.team/PLAN.md' do Leader vừa lập.
1. Nghiên cứu các hạng mục Backend trong PLAN.md.
2. Tiến hành code, sửa bug hoặc bổ sung các endpoint API/logic backend tương ứng.
3. Tuân thủ nghiêm ngặt Karpathy Guidelines: code đơn giản nhất, thay đổi có mục tiêu (surgical changes), không sửa code ngoài phạm vi.
4. Sau khi hoàn thành, hãy ghi báo cáo tóm tắt các file đã sửa và logic backend vào file '.team/BACKEND_REPORT.md'.
Khi hoàn tất, trả lời: 'Backend hoàn tất. Chi tiết tại .team/BACKEND_REPORT.md'.
`.trim();

  await promptAgent(roles.BACKEND, backendPrompt, 900000);

  // STAGE 3: FRONTEND IMPLEMENTATION
  const frontendPrompt = `
Bạn là Frontend Engineer.
Nhiệm vụ: Đọc kỹ file '.team/PLAN.md' và '.team/BACKEND_REPORT.md' vừa hoàn thành.
1. Cập nhật và điều chỉnh giao diện, component, state, form hoặc logic gọi API ở frontend cho phù hợp với backend.
2. Đảm bảo giao diện trực quan, thẩm mỹ cao, không phá vỡ layout hiện có.
3. Sau khi hoàn thành, hãy ghi báo cáo tóm tắt các file frontend đã sửa vào file '.team/FRONTEND_REPORT.md'.
Khi hoàn tất, trả lời: 'Frontend hoàn tất. Chi tiết tại .team/FRONTEND_REPORT.md'.
`.trim();

  await promptAgent(roles.FRONTEND, frontendPrompt, 900000);

  // STAGE 4: QA / TESTING
  const testerPrompt = `
Bạn là QA / Tester.
Nhiệm vụ: Đọc '.team/PLAN.md', '.team/BACKEND_REPORT.md' và '.team/FRONTEND_REPORT.md'.
1. Chạy regression test backend nếu có (ví dụ: npm test).
2. Chạy kiểm tra frontend nếu có (ví dụ: npm run lint, npm run build).
3. Ghi lại toàn bộ kết quả kiểm thử (PASS/FAIL/SKIP) và log chi tiết vào file '.team/TEST_REPORT.md'. Nếu phát hiện lỗi, hãy nêu rõ nguyên nhân.
Khi hoàn tất, trả lời: 'Kiểm thử hoàn tất. Chi tiết tại .team/TEST_REPORT.md'.
`.trim();

  await promptAgent(roles.TESTER, testerPrompt, 600000);

  // STAGE 5: FINAL REPORT
  const reportPrompt = `
Bạn là Lead Architect kiêm Project Manager.
Toàn bộ đội ngũ đã hoàn thành các giai đoạn:
- Kế hoạch: .team/PLAN.md
- Backend: .team/BACKEND_REPORT.md
- Frontend: .team/FRONTEND_REPORT.md
- Kiểm thử: .team/TEST_REPORT.md

Hãy đọc toàn bộ các tài liệu trên và kiểm tra git status/git diff.
Sau đó, hãy viết một bản BÁO CÁO TỔNG HỢP HOÀN CHỈNH lưu tại file 'REPORT.md' ở thư mục gốc bao gồm:
1. Tóm tắt kết quả nhiệm vụ.
2. Chi tiết các thay đổi Backend.
3. Chi tiết các thay đổi Frontend.
4. Báo cáo kiểm thử & độ tin cậy.
5. Hướng dẫn trải nghiệm / kiểm tra lại cho người dùng.
Khi hoàn tất, trả lời: 'Báo cáo tổng kết đã sẵn sàng tại REPORT.md'.
`.trim();

  await promptAgent(roles.LEADER, reportPrompt, 600000);

  const totalSec = ((Date.now() - totalStart) / 1000).toFixed(1);

  console.log('\n============================================================');
  console.log(`🎉 QUY TRÌNH ĐỘI NGŨ HOÀN THÀNH XUẤT SẮC TRONG ${totalSec}s!`);
  console.log('📄 Báo cáo tổng kết: REPORT.md');
  console.log('📁 Chi tiết từng giai đoạn: .team/');
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
  const taskArgs = args.filter((a) => a !== '--init-only' && a !== '-i');
  const task = taskArgs.join(' ').trim();

  const roles = await ensureWorkspaceAndAgents();

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
