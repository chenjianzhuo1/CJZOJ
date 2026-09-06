const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// 初始化数据库
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
        users: [],
        problems: [],
        submissions: [],
        posts: [],
        articles: [],
        contests: [],
        pendingProblems: [],
        pendingContests: [],
        bindings: []   // { userId, atcoder: { handle, cookies }, spoj: {...}, uva: {...} }
    }, null, 2));
}

function readDB() {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 生成唯一ID
function generateId() {
    return Date.now() + Math.floor(Math.random() * 1000);
}

// ---------- 用户认证 ----------
app.post('/api/register', (req, res) => {
    const { username, email, password } = req.body;
    const db = readDB();
    if (db.users.some(u => u.email === email)) {
        return res.status(400).json({ message: '邮箱已被注册' });
    }
    const isFirstUser = db.users.length === 0;
    const newUser = {
        id: generateId(),
        username,
        email,
        password: Buffer.from(password).toString('base64'),
        role: isFirstUser ? 'admin' : 'user',
        solvedProblems: [],
        createdAt: new Date().toISOString()
    };
    db.users.push(newUser);
    writeDB(db);
    res.json({ message: '注册成功', user: { id: newUser.id, username, email, role: newUser.role } });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.email === email);
    if (!user || user.password !== Buffer.from(password).toString('base64')) {
        return res.status(401).json({ message: '邮箱或密码错误' });
    }
    res.json({ message: '登录成功', user: { id: user.id, username: user.username, email: user.email, role: user.role } });
});

// ---------- 账号绑定（保存 Cookie 用于真实 RMJ）----------
app.get('/api/bindings/:userId', (req, res) => {
    const db = readDB();
    const userId = parseInt(req.params.userId);
    const binding = db.bindings.find(b => b.userId === userId);
    res.json(binding || { userId, atcoder: null, spoj: null, uva: null });
});

app.post('/api/bindings', (req, res) => {
    const db = readDB();
    const { userId, platform, handle, cookies } = req.body;
    if (!userId || !platform || !handle || !cookies) {
        return res.status(400).json({ message: '参数不完整' });
    }
    let binding = db.bindings.find(b => b.userId === userId);
    if (!binding) {
        binding = { userId, atcoder: null, spoj: null, uva: null };
        db.bindings.push(binding);
    }
    binding[platform] = {
        handle,
        cookies: JSON.parse(cookies),  // 前端传入的是JSON字符串
        updatedAt: new Date().toISOString()
    };
    writeDB(db);
    res.json({ message: '绑定成功', binding });
});

// ---------- 题目相关 ----------
app.get('/api/problems', (req, res) => {
    const db = readDB();
    res.json(db.problems);
});

app.get('/api/problems/:id', (req, res) => {
    const db = readDB();
    const id = parseInt(req.params.id);
    const problem = db.problems.find(p => p.id === id);
    if (!problem) return res.status(404).json({ message: '题目不存在' });
    res.json(problem);
});

app.post('/api/problems/submit', (req, res) => {
    const db = readDB();
    const { title, difficulty, tags, description, inputFormat, outputFormat, sampleInput, sampleOutput, testCases, timeLimit, memoryLimit, authorId, authorName } = req.body;
    const newPending = {
        id: generateId(),
        title, difficulty, tags, description, inputFormat, outputFormat, sampleInput, sampleOutput, testCases, timeLimit, memoryLimit,
        authorId, authorName,
        status: 'pending',
        submittedAt: new Date().toISOString()
    };
    db.pendingProblems.push(newPending);
    writeDB(db);
    res.status(201).json({ message: '题目已提交，等待审核' });
});

// ---------- 提交记录 ----------
app.get('/api/submissions', (req, res) => {
    const db = readDB();
    const subs = db.submissions.slice().reverse();
    const enriched = subs.map(sub => {
        const user = db.users.find(u => u.id === sub.userId);
        let problemTitle = '';
        if (sub.remotePlatform) {
            problemTitle = `${sub.remotePlatform} ${sub.remoteProblemId}`;
        } else {
            const problem = db.problems.find(p => p.id === sub.problemId);
            problemTitle = problem ? problem.title : '未知题目';
        }
        return { ...sub, username: user ? user.username : '未知用户', problemTitle };
    });
    res.json(enriched);
});

// 提交代码（本地模拟 + 真实远程评测）
app.post('/api/submissions', async (req, res) => {
    const db = readDB();
    const { userId, problemId, code, language, remotePlatform, remoteProblemId } = req.body;
    const submission = {
        id: generateId(),
        userId,
        problemId: problemId || null,
        remotePlatform: remotePlatform || null,
        remoteProblemId: remoteProblemId || null,
        code,
        language,
        status: 'pending',
        executionTime: 0,
        memoryUsed: 0,
        details: '',
        submittedAt: new Date().toISOString()
    };
    db.submissions.push(submission);
    writeDB(db);

    if (remotePlatform) {
        // 远程评测，异步处理真实提交
        res.status(201).json({ message: '提交成功，正在远程评测', submissionId: submission.id });
        processRemoteJudge(submission.id).catch(err => {
            console.error('RMJ error:', err);
            const dbNow = readDB();
            const sub = dbNow.submissions.find(s => s.id === submission.id);
            if (sub) {
                sub.status = 'runtime_error';
                sub.details = err.message;
                writeDB(dbNow);
            }
        });
    } else {
        // 本地模拟评测
        setTimeout(() => {
            const dbNow = readDB();
            const sub = dbNow.submissions.find(s => s.id === submission.id);
            if (sub) {
                sub.status = Math.random() > 0.5 ? 'accepted' : 'wrong_answer';
                sub.executionTime = Math.floor(Math.random() * 500) + 50;
                writeDB(dbNow);
            }
        }, 1000);
        res.status(201).json({ message: '提交成功', submissionId: submission.id });
    }
});

// ---------- 真实远程评测核心 ----------
async function processRemoteJudge(submissionId) {
    const db = readDB();
    const submission = db.submissions.find(s => s.id === submissionId);
    if (!submission) return;

    const userBinding = db.bindings.find(b => b.userId === submission.userId);
    if (!userBinding || !userBinding[submission.remotePlatform]) {
        throw new Error('用户未绑定该平台账号');
    }
    const binding = userBinding[submission.remotePlatform];
    if (!binding.cookies) {
        throw new Error('绑定信息缺少 Cookies，无法自动提交');
    }

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    try {
        const page = await browser.newPage();
        // 设置 Cookie（保存的是JSON数组）
        await page.setCookie(...binding.cookies);

        let result;
        if (submission.remotePlatform === 'atcoder') {
            result = await submitAtCoder(page, submission, binding);
        } else if (submission.remotePlatform === 'spoj') {
            result = await submitSPOJ(page, submission, binding);
        } else if (submission.remotePlatform === 'uva') {
            result = await submitUVA(page, submission, binding);
        } else {
            throw new Error('不支持的平台');
        }

        // 更新数据库
        const dbNow = readDB();
        const sub = dbNow.submissions.find(s => s.id === submissionId);
        if (sub) {
            sub.status = result.status;
            sub.executionTime = result.time || 0;
            sub.memoryUsed = result.memory || 0;
            sub.details = result.details || '';
            writeDB(dbNow);
        }
    } finally {
        await browser.close();
    }
}

// AtCoder 提交实现
async function submitAtCoder(page, submission, binding) {
    const match = submission.remoteProblemId.match(/^([a-z0-9]+)_([a-z0-9_]+)$/i);
    if (!match) throw new Error('AtCoder 题目ID格式应为 contest_task，例如 abc123_a');
    const contestId = match[1];
    const taskId = submission.remoteProblemId;

    const submitUrl = `https://atcoder.jp/contests/${contestId}/submit`;
    await page.goto(submitUrl, { waitUntil: 'networkidle0', timeout: 30000 });

    if (page.url().includes('/login')) {
        throw new Error('AtCoder Cookie 已失效，请重新绑定');
    }

    await page.select('select[name="data.TaskScreenName"]', taskId);

    const langMap = {
        'cpp': '4003',
        'python': '4006',
        'java': '4005',
        'javascript': '4021'
    };
    if (!langMap[submission.language]) throw new Error('不支持的语言');
    await page.select('select[name="data.LanguageId"]', langMap[submission.language]);

    await page.evaluate((code) => {
        const cm = document.querySelector('.CodeMirror').CodeMirror;
        if (cm) cm.setValue(code);
    }, submission.code);

    await Promise.all([
        page.click('#submit'),
        page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 })
    ]);

    const submissionIdMatch = page.url().match(/\/submissions\/(\d+)/);
    if (!submissionIdMatch) throw new Error('未能获取 AtCoder 提交ID');
    const remoteId = submissionIdMatch[1];

    for (let i = 0; i < 30; i++) {
        await page.goto(`https://atcoder.jp/contests/${contestId}/submissions/${remoteId}`, { waitUntil: 'networkidle0' });
        const statusText = await page.evaluate(() => {
            const el = document.querySelector('#judge-status');
            return el ? el.textContent.trim() : 'Waiting for judge';
        });
        if (statusText.includes('Accepted') || statusText.includes('Wrong Answer') || statusText.includes('Time Limit Exceeded') || statusText.includes('Runtime Error') || statusText.includes('Compile Error')) {
            const time = await page.$eval('#judge-time', el => el.textContent.trim()).catch(() => '0ms');
            const memory = await page.$eval('#judge-memory', el => el.textContent.trim()).catch(() => '0KB');
            return {
                status: normalizeAtCoderVerdict(statusText),
                time: parseInt(time) || 0,
                memory: parseInt(memory) || 0,
                details: statusText
            };
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error('AtCoder 评测超时');
}

function normalizeAtCoderVerdict(text) {
    if (text.includes('Accepted')) return 'accepted';
    if (text.includes('Wrong Answer')) return 'wrong_answer';
    if (text.includes('Time Limit Exceeded')) return 'time_limit_exceeded';
    if (text.includes('Runtime Error')) return 'runtime_error';
    if (text.includes('Compile Error')) return 'compile_error';
    return 'pending';
}

// SPOJ 提交（简化版，仅模拟提交，具体选择器需根据实际页面调整）
async function submitSPOJ(page, submission, binding) {
    await page.goto('https://www.spoj.com/submit/', { waitUntil: 'networkidle0' });
    // 选择语言
    const langMap = {
        'cpp': '44',
        'python': '116',
        'java': '10',
        'javascript': '112'
    };
    if (!langMap[submission.language]) throw new Error('不支持的语言');
    await page.select('#lang', langMap[submission.language]);
    await page.type('#problem', submission.remoteProblemId);
    await page.evaluate((code) => {
        const codeArea = document.querySelector('#code');
        if (codeArea) codeArea.value = code;
    }, submission.code);
    await Promise.all([
        page.click('#submit'),
        page.waitForNavigation({ waitUntil: 'networkidle0' })
    ]);
    // 此处简化：提交后无法立即获取结果，返回 pending
    return { status: 'pending', time: 0, memory: 0, details: 'SPOJ 提交成功，请稍后查看结果' };
}

// UVA 提交（简化版，仅模拟提交）
async function submitUVA(page, submission, binding) {
    // UVA 需要先登录并跳转到提交页面，这里省略具体步骤
    return { status: 'pending', time: 0, memory: 0, details: 'UVA 提交成功，请稍后查看结果' };
}

// ---------- 讨论区 ----------
app.get('/api/posts', (req, res) => {
    const db = readDB();
    res.json(db.posts);
});

app.post('/api/posts', (req, res) => {
    const db = readDB();
    const { title, content, authorId, authorName } = req.body;
    const newPost = {
        id: generateId(),
        title, content, authorId, authorName,
        createdAt: new Date().toISOString(),
        replies: []
    };
    db.posts.push(newPost);
    writeDB(db);
    res.status(201).json(newPost);
});

app.post('/api/posts/:id/reply', (req, res) => {
    const db = readDB();
    const postId = parseInt(req.params.id);
    const { content, authorId, authorName } = req.body;
    const post = db.posts.find(p => p.id === postId);
    if (!post) return res.status(404).json({ message: '帖子不存在' });
    post.replies.push({
        id: generateId(),
        content, authorId, authorName,
        createdAt: new Date().toISOString()
    });
    writeDB(db);
    res.json(post);
});

// ---------- 文章区 ----------
app.get('/api/articles', (req, res) => {
    const db = readDB();
    const approved = db.articles.filter(a => a.status === 'approved');
    res.json(approved);
});

app.post('/api/articles', (req, res) => {
    const db = readDB();
    const { title, content, authorId, authorName } = req.body;
    const newArticle = {
        id: generateId(),
        title, content, authorId, authorName,
        status: 'pending',
        createdAt: new Date().toISOString()
    };
    db.articles.push(newArticle);
    writeDB(db);
    res.status(201).json({ message: '文章已提交，等待审核' });
});

// ---------- 比赛 ----------
app.get('/api/contests', (req, res) => {
    const db = readDB();
    res.json(db.contests);
});

app.post('/api/contests', (req, res) => {
    const db = readDB();
    const { title, type, startTime, endTime, problemIds, authorId, authorName } = req.body;
    const newContest = {
        id: generateId(),
        title, type, startTime, endTime, problemIds,
        authorId, authorName,
        status: 'pending'
    };
    db.pendingContests.push(newContest);
    writeDB(db);
    res.status(201).json({ message: '比赛申请已提交' });
});

// ---------- 管理员后台 ----------
app.get('/api/admin/pending-problems', (req, res) => {
    const db = readDB();
    res.json(db.pendingProblems.filter(p => p.status === 'pending'));
});

app.post('/api/admin/problems/approve', (req, res) => {
    const db = readDB();
    const { pendingId } = req.body;
    const pending = db.pendingProblems.find(p => p.id === pendingId);
    if (!pending) return res.status(404).json({ message: '未找到' });
    const newProblem = { ...pending, id: generateId(), status: 'approved' };
    delete newProblem.authorId;
    delete newProblem.authorName;
    db.problems.push(newProblem);
    db.pendingProblems = db.pendingProblems.filter(p => p.id !== pendingId);
    writeDB(db);
    res.json({ message: '已通过' });
});

app.post('/api/admin/problems/reject', (req, res) => {
    const db = readDB();
    const { pendingId } = req.body;
    db.pendingProblems = db.pendingProblems.filter(p => p.id !== pendingId);
    writeDB(db);
    res.json({ message: '已拒绝' });
});

app.get('/api/admin/pending-articles', (req, res) => {
    const db = readDB();
    res.json(db.articles.filter(a => a.status === 'pending'));
});

app.post('/api/admin/articles/approve', (req, res) => {
    const db = readDB();
    const { articleId } = req.body;
    const article = db.articles.find(a => a.id === articleId);
    if (article) {
        article.status = 'approved';
        writeDB(db);
    }
    res.json({ message: '已通过' });
});

app.post('/api/admin/articles/reject', (req, res) => {
    const db = readDB();
    const { articleId } = req.body;
    const article = db.articles.find(a => a.id === articleId);
    if (article) {
        article.status = 'rejected';
        writeDB(db);
    }
    res.json({ message: '已拒绝' });
});

app.get('/api/admin/pending-contests', (req, res) => {
    const db = readDB();
    res.json(db.pendingContests.filter(c => c.status === 'pending'));
});

app.post('/api/admin/contests/approve', (req, res) => {
    const db = readDB();
    const { contestId } = req.body;
    const pending = db.pendingContests.find(c => c.id === contestId);
    if (pending) {
        db.contests.push({ ...pending, id: generateId(), status: 'approved' });
        db.pendingContests = db.pendingContests.filter(c => c.id !== contestId);
        writeDB(db);
    }
    res.json({ message: '已通过' });
});

app.post('/api/admin/contests/reject', (req, res) => {
    const db = readDB();
    const { contestId } = req.body;
    db.pendingContests = db.pendingContests.filter(c => c.id !== contestId);
    writeDB(db);
    res.json({ message: '已拒绝' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});