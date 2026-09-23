const { chromium } = require('playwright');
const fs = require('fs');

if (!fs.existsSync('screenshots')) {
  fs.mkdirSync('screenshots');
}

// ===== FreeMCHost 认证配置（站点使用 Supabase Auth，会话存储在 localStorage）=====
// 站点前端为 Lovable + Supabase 构建，登录表单带 bylegit 反机器人组件，直接驱动表单易被拦截。
// 改为：通过 Supabase REST API 用邮箱密码换取 session（REST 接口无 captcha 校验），
//       再把 session 注入 localStorage（键 sb-<project-ref>-auth-token），跳过登录表单。
//       也可用 FREE_SESSION 直接注入预先导出的会话（纯 token 登录，免密码）。
const SUPABASE_URL = 'https://laehfeigoiycigkfknfn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxhZWhmZWlnb2l5Y2lna2ZrbmZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNzk1NTgsImV4cCI6MjA5NTg1NTU1OH0.r-CQTnTFWYj5Vawvn1Ky91QnPJMcp1feIRFWJrhq7T8';
const STORAGE_KEY = 'sb-laehfeigoiycigkfknfn-auth-token';

// Telegram 通知工具
async function sendTelegramMessage(botToken, chatId, text) {
  if (!botToken || !chatId) {
    console.log('⚠️ 未配置 TG_BOT_TOKEN 或 TG_CHAT_ID，跳过通知。');
    return;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    const result = await res.json();
    if (result.ok) {
      console.log('📢 TG 通知已成功送达！');
    } else {
      console.error('⚠️ TG 接口拒收:', result.description);
      if (result.description && result.description.includes("can't parse entities")) {
        console.log('🔄 检测到 HTML 实体冲突，正在以纯文本重新补发...');
        const plainText = text.replace(/<[^>]+>/g, '');
        const retryRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: plainText })
        });
        const retryResult = await retryRes.json();
        if (retryResult.ok) console.log('📢 TG 纯文本通知补发成功！');
      }
    }
  } catch (err) {
    console.error('❌ TG 网络请求异常:', err.message);
  }
}

// 🛡️ 精准清理干扰弹窗
async function forceDismissPopups(page) {
  try {
    const cookieBtn = page.locator('button:has-text("Accept all"), button:has-text("Reject all")').first();
    if (await cookieBtn.isVisible({ timeout: 400 })) {
      await cookieBtn.click();
    }
  } catch (e) {}

  try {
    const isInterferingModalVisible = await page.evaluate(() => {
      const txt = document.body.innerText || '';
      return (
        txt.includes('How would you rate FreeMCHost') ||
        txt.includes('Your feedback') ||
        txt.includes('Got an idea to make FreeMCHost better') ||
        txt.includes('Get Free+ (2GB)') ||
        txt.includes('Upgrade to Free+') ||
        txt.includes('Join the FreeMCHost community')
      );
    });

    if (isInterferingModalVisible) {
      const maybeLater = page.locator('button, a, span, div').filter({ hasText: /^Maybe later$/i }).first();
      if (await maybeLater.isVisible({ timeout: 500 })) {
        await maybeLater.click({ force: true });
        console.log('🛡️ 已点击 [Maybe later] 关闭干扰弹窗');
        await page.waitForTimeout(300);
      }
    }
  } catch (e) {}

  await page.evaluate(() => {
    const allEls = Array.from(document.querySelectorAll('*'));
    const noiseHeaders = allEls.filter(el => {
      const txt = el.textContent || '';
      return (
        txt.includes('How would you rate FreeMCHost') ||
        txt.includes('Your feedback') ||
        txt.includes('Got an idea to make FreeMCHost better') ||
        txt.includes('Get Free+ (2GB)') ||
        txt.includes('Upgrade to Free+') ||
        txt.includes('Join the FreeMCHost community')
      );
    });

    noiseHeaders.forEach(header => {
      let container = header;
      for (let i = 0; i < 7; i++) {
        if (container.parentElement && container.parentElement !== document.body) {
          if (container.innerText && container.innerText.includes('Keep your server online')) {
            return;
          }
          container = container.parentElement;
        }
      }
      if (container && container !== document.body && !container.innerText.includes('Keep your server online')) {
        container.remove();
      }
    });

    const backdrops = allEls.filter(el =>
      el.classList && el.classList.contains('fixed') && el.classList.contains('inset-0') && el.getAttribute('data-state') === 'open'
    );
    backdrops.forEach(b => b.remove());
  });

  await page.waitForTimeout(200);
}

// 切换至 PLAN Billing 标签页
async function switchToBillingTab(page) {
  const tabCandidates = page.locator('button, a, div[role="tab"]').filter({ hasText: /Billing/i });
  const count = await tabCandidates.count();
  for (let idx = 0; idx < count; idx++) {
    const item = tabCandidates.nth(idx);
    if (await item.isVisible().catch(() => false)) {
      const txt = await item.innerText().catch(() => '');
      if (!txt.includes('Total') && (txt.includes('Billing') || txt.includes('PLAN'))) {
        await item.click({ force: true });
        console.log(`👉 已点击标签: [${txt.replace(/\n/g, ' ')}]`);
        break;
      }
    }
  }
  await page.waitForTimeout(2500);
  await forceDismissPopups(page);
}

// 倒计时提取器
async function extractExpiryTime(page) {
  return await page.evaluate(() => {
    const allEls = Array.from(document.querySelectorAll('*'));
    const header = allEls.find(el => el.textContent && el.textContent.trim().toUpperCase() === 'TIME UNTIL EXPIRY');

    if (header) {
      let container = header.parentElement;
      for (let k = 0; k < 4; k++) {
        if (container) {
          const txt = container.innerText || '';
          const m = txt.match(/(\d{1,3})\s*\n?\s*D[\s\S]*?(\d{1,2})\s*\n?\s*H[\s\S]*?(\d{1,2})\s*\n?\s*M/i);
          if (m) {
            const d = parseInt(m[1], 10);
            const h = parseInt(m[2], 10);
            const min = parseInt(m[3], 10);
            return { totalHours: d * 24 + h + min / 60, raw: `${d}天${h}小时${min}分` };
          }
          container = container.parentElement;
        }
      }
    }

    const bodyText = document.body.innerText || '';
    const fallbackMatch = bodyText.match(/(\d{1,3})\s*\n?\s*D\s*\n?\s*(\d{1,2})\s*\n?\s*H\s*\n?\s*(\d{1,2})\s*\n?\s*M/i);
    if (fallbackMatch) {
      const d = parseInt(fallbackMatch[1], 10);
      const h = parseInt(fallbackMatch[2], 10);
      const min = parseInt(fallbackMatch[3], 10);
      return { totalHours: d * 24 + h + min / 60, raw: `${d}天${h}小时${min}分` };
    }

    return null;
  });
}

async function safeScreenshot(page, filePath) {
  try {
    await page.screenshot({ path: filePath, fullPage: false, timeout: 5000 });
  } catch (e) {
    console.log(`⚠️ 截图生成跳过: ${e.message}`);
  }
}

// ===== 会话获取：优先 FREE_SESSION（纯 token），否则 Supabase REST 邮箱密码登录 =====
async function obtainSession() {
  // 模式 B：直接注入预先导出的会话（从浏览器 localStorage 复制的 sb-...-auth-token 值）
  const rawSession = (process.env.FREE_SESSION || '').trim();
  if (rawSession) {
    try {
      const sess = JSON.parse(rawSession);
      if (sess && sess.access_token) {
        console.log('🔑 使用 FREE_SESSION 注入会话（纯 token 登录，跳过密码）...');
        return sess;
      }
      console.warn('⚠️ FREE_SESSION 缺少 access_token，回退到邮箱密码登录。');
    } catch (e) {
      console.warn(`⚠️ FREE_SESSION 解析失败(${e.message})，回退到邮箱密码登录。`);
    }
  }

  // 模式 A：Supabase REST API 邮箱密码登录（绕过 bylegit 表单，无 captcha）
  const email = (process.env.FREE_EMAIL || '').trim();
  const password = (process.env.FREE_PASSWORD || '').trim();
  if (!email || !password) {
    throw new Error('未配置 FREE_SESSION，也未配置 FREE_EMAIL/FREE_PASSWORD，无法获取会话。');
  }

  console.log(`🔐 通过 Supabase REST API 登录 (${email})...`);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, password })
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(`Supabase 登录响应解析失败: HTTP ${res.status}`);
  }

  if (!res.ok || !data || !data.access_token) {
    const msg = (data && (data.msg || data.error_description || data.error_code)) || `HTTP ${res.status}`;
    throw new Error(`Supabase 登录失败: ${msg}`);
  }

  console.log(`✅ REST 登录成功 (user: ${data.user?.email || data.user?.id})`);
  return data; // { access_token, refresh_token, token_type, expires_in, expires_at, user }
}

(async () => {
  const rawUrls = (process.env.SERVER_PAGE_URL || '').trim();
  const proxyUrl = (process.env.PROXY_URL || '').trim();
  const tgToken = (process.env.TG_BOT_TOKEN || '').trim();
  const tgChatId = (process.env.TG_CHAT_ID || '').trim();

  const serverUrls = rawUrls
    .split(/[\r\n,]+/)
    .map(u => u.trim())
    .filter(u => u.startsWith('http'));

  const hasSession = !!(process.env.FREE_SESSION || '').trim();
  const hasPassword = !!(process.env.FREE_EMAIL || '').trim() && !!(process.env.FREE_PASSWORD || '').trim();

  if ((!hasSession && !hasPassword) || serverUrls.length === 0) {
    console.error('❌ 缺失凭据（需配置 FREE_SESSION 或 FREE_EMAIL/FREE_PASSWORD）或有效的 SERVER_PAGE_URL！');
    process.exit(1);
  }

  console.log(`📋 检测到 ${serverUrls.length} 个独立服务器地址待巡检...`);

  // 先获取会话（REST 登录或 FREE_SESSION）
  const session = await obtainSession();

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ],
    proxy: proxyUrl ? { server: proxyUrl } : undefined
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US'
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // 💉 核心：在每个页面脚本执行前，把 Supabase 会话写入 localStorage，
  //        使 SPA 加载时即处于已登录状态，无需经过 /login 表单（绕过 bylegit）。
  const sessionJson = JSON.stringify(session);
  await context.addInitScript(({ key, value }) => {
    try {
      if (location.hostname.endsWith('freemchost.com')) {
        localStorage.setItem(key, value);
      }
    } catch (e) {}
  }, { key: STORAGE_KEY, value: sessionJson });
  console.log('💉 Supabase 会话已注入 localStorage，跳过登录表单。');

  const page = await context.newPage();

  // 📡 全量拦截并打印除静态资源外的所有网络请求，观察真实 API 端点
  page.on('request', req => {
    const url = req.url();
    const type = req.resourceType();
    if (['xhr', 'fetch'].includes(type) && !url.includes('google') && !url.includes('analytics')) {
      console.log(`📤 发起网络请求: [${req.method()}] ${url.substring(0, 100)}`);
    }
  });

  page.on('response', res => {
    const req = res.request();
    const url = res.url();
    const type = req.resourceType();
    if (['xhr', 'fetch'].includes(type) && !url.includes('google') && !url.includes('analytics')) {
      console.log(`📥 收到网络响应: [${res.status()}] ${url.substring(0, 100)}`);
    }
  });

  let reports = [];

  try {
    // 先访问 /app 验证会话注入是否生效（未登录会被重定向到 /login）
    console.log('🚀 正在校验会话有效性 (打开 /app)...');
    await page.goto('https://freemchost.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    await forceDismissPopups(page);

    if (page.url().includes('/login')) {
      throw new Error('会话注入后仍被重定向到 /login —— 会话无效或已过期，请检查 FREE_SESSION 或 FREE_EMAIL/FREE_PASSWORD。');
    }
    console.log('✅ 会话注入成功，已通过认证！');

    for (let i = 0; i < serverUrls.length; i++) {
      const currentUrl = serverUrls[i];
      const sIndex = i + 1;
      console.log(`\n================= 正在巡检服务器 [${sIndex}/${serverUrls.length}] =================`);
      console.log(`🔗 目标地址: ${currentUrl}`);

      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        await forceDismissPopups(page);

        if (page.url().includes('/login')) {
          throw new Error('访问服务器页被重定向到 /login，会话失效。');
        }

        console.log('🗂️ 正在定位并点击 [PLAN Billing] 标签页...');
        await switchToBillingTab(page);

        const renewBtn = page.locator('button:has-text("Renew now")').first();
        await renewBtn.waitFor({ state: 'visible', timeout: 15000 });
        await page.waitForTimeout(1000);
        await forceDismissPopups(page);

        // 提取初始真实时间
        const timeData = await extractExpiryTime(page);
        const remainHours = timeData ? timeData.totalHours : 99;
        const remainStr = timeData ? timeData.raw : '未读取到';
        console.log(`⏱️ 服务器 [${sIndex}] 实际剩余时长: ${remainStr} (约 ${remainHours.toFixed(1)} 小时)`);

        if (remainHours < 46) {
          console.log(`🎯 剩余时长 < 46 小时，打开续期弹窗...`);
          await renewBtn.click();
          await page.waitForTimeout(1500);
          await forceDismissPopups(page);

          console.log('⏳ 等待 [60 hours] 选项解锁 (等待 3-5 秒后端校验)...');
          const renewModal = page.locator('div').filter({ hasText: 'Keep your server online' }).last();
          await renewModal.waitFor({ state: 'visible', timeout: 10000 });

          for (let poll = 0; poll < 10; poll++) {
            const isReady = await page.evaluate(() => {
              const text = document.body.innerText || '';
              return !text.toLowerCase().includes('come back later');
            });

            if (isReady && poll >= 3) {
              console.log(`✅ [60 hours] 选项状态已解锁！`);
              break;
            }
            await page.waitForTimeout(1200);
          }

          console.log('👉 执行【高精度多层真实事件穿透点击】...');

          // 核心加固：直接在浏览器内部定位包含 60 hours 的卡片，并派发全套鼠标/指针事件链
          const clickedTarget = await page.evaluate(() => {
            const allEls = Array.from(document.querySelectorAll('*'));
            const textEl = allEls.find(el =>
              el.children.length === 0 &&
              el.textContent.trim().toLowerCase().includes('60 hours')
            );
            if (!textEl) return '未找到文本节点';

            // 寻找带有边框或卡片样式的交互祖先
            let card = textEl;
            for (let j = 0; j < 6; j++) {
              if (card.parentElement && card.parentElement !== document.body) {
                const cls = (card.parentElement.className || '').toString();
                if (cls.includes('rounded') || cls.includes('border') || card.parentElement.tagName === 'BUTTON') {
                  card = card.parentElement;
                  break;
                }
                card = card.parentElement;
              }
            }

            // 完整派发 pointerdown -> mousedown -> focus -> mouseup -> click
            const rect = card.getBoundingClientRect();
            const clientX = rect.left + rect.width / 2;
            const clientY = rect.top + rect.height / 2;

            const opts = { bubbles: true, cancelable: true, view: window, clientX, clientY };
            card.dispatchEvent(new PointerEvent('pointerdown', opts));
            card.dispatchEvent(new MouseEvent('mousedown', opts));
            card.focus();
            card.dispatchEvent(new PointerEvent('pointerup', opts));
            card.dispatchEvent(new MouseEvent('mouseup', opts));
            card.dispatchEvent(new MouseEvent('click', opts));

            // 如果内部有真正的 button 或 radio input，也顺带触发一次
            const innerBtn = card.querySelector('button, input');
            if (innerBtn) {
              innerBtn.click();
            }

            return `已触发卡片标签: <${card.tagName.toLowerCase()}> 类名: ${card.className.substring(0, 50)}`;
          });

          console.log(`🖱️ 穿透结果: ${clickedTarget}`);

          // 辅以 Playwright 原生物理鼠标点击（双保险）
          try {
            const locatorCard = renewModal.locator('div, button').filter({ hasText: /60\s*hours/i }).last();
            if (await locatorCard.isVisible()) {
              await locatorCard.click({ force: true, delay: 100 });
              console.log('🖱️ 原生 locator.click 派发成功！');
            }
          } catch (e) {}

          // 等待接口交互与入库
          console.log('⏳ 等待服务端完成网络通信与入账 (10 秒)...');
          await page.waitForTimeout(10000);

          // 关掉可能随后弹出的 Discord 推广弹窗
          await forceDismissPopups(page);

          // 核心硬核验：打开全新无缓存页面进行数据库落地确认
          console.log('🔍 正在启动跨上下文硬核验，核查真实入库倒计时...');
          const verifyPage = await context.newPage();
          await verifyPage.goto(currentUrl, { waitUntil: 'networkidle', timeout: 60000 });
          await verifyPage.waitForTimeout(2000);
          await forceDismissPopups(verifyPage);

          await switchToBillingTab(verifyPage);
          const verifyRenewBtn = verifyPage.locator('button:has-text("Renew now")').first();
          await verifyRenewBtn.waitFor({ state: 'visible', timeout: 15000 });
          await verifyPage.waitForTimeout(1000);

          const finalTimeData = await extractExpiryTime(verifyPage);
          const finalHours = finalTimeData ? finalTimeData.totalHours : remainHours;
          const finalStr = finalTimeData ? finalTimeData.raw : '未获取到';
          await safeScreenshot(verifyPage, `screenshots/server-${sIndex}-final-verify.png`);
          await verifyPage.close();

          console.log(`⏱️ 全新页面核验结果: 前序 ${remainHours.toFixed(1)}h ➔ 真实数据库时间: ${finalHours.toFixed(1)}h (${finalStr})`);

          // 只有真实数据增加了 20 小时以上才算入库
          if (finalHours > remainHours + 20) {
            console.log('🎉 验证通过：后端数据库已落盘！');
            reports.push(`🟢 <b>服务器 ${sIndex}</b>: 成功满血续期 (+60h)\n     └ 状态: ${remainStr} ➔ <b>${finalStr}</b>`);
          } else {
            console.error('❌ 验证失败：后端数据未真正更新！');
            reports.push(`🔴 <b>服务器 ${sIndex}</b>: 续期指令下发但后端未入账 (当前: ${finalStr})\n     └ 机制: 下个 12h 周期将自动重试`);
          }

        } else {
          console.log(`⏳ 服务器 [${sIndex}] 距离 46h 开放还差约 ${(remainHours - 46).toFixed(1)} 小时，保持等待。`);
          reports.push(`⚪ <b>服务器 ${sIndex}</b>: 剩余 ${remainStr} (未达 46h)`);
        }

      } catch (innerErr) {
        console.error(`❌ 服务器 [${sIndex}] 处理异常:`, innerErr.message);
        reports.push(`🔴 <b>服务器 ${sIndex}</b>: 巡检失败 (${innerErr.message.substring(0, 30)})`);
        await safeScreenshot(page, `screenshots/error-server-${sIndex}.png`);
      }
    }

    // 汇总推送 Telegram 报告
    const summaryMsg = `🤖 <b>FreeMCHost 巡检报告</b>\n\n${reports.join('\n')}\n\n<b>检查周期:</b> 每 6 小时自动巡检\n<b>登录方式:</b> Supabase 会话注入\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    await sendTelegramMessage(tgToken, tgChatId, summaryMsg);

  } catch (error) {
    console.error('❌ 全局致命错误:', error.message);
    await safeScreenshot(page, 'screenshots/renew_fatal.png');
    await sendTelegramMessage(tgToken, tgChatId, `🚨 <b>Freemchost 运行崩溃:</b> <code>${error.message}</code>`);
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('🏁 任务完成，浏览器已关闭。');
  }
})();
