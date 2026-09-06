const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');

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
        bindings: []
    }, null, 2));
}

function readDB() {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// 工具函数
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

// ---------- 账号绑定 ----------
app.get('/api/bindings/:userId', (req, res) => {
    const db = readDB();
    const userId = parseInt(req.params.userId);
    const binding = db.bindings.find(b => b.userId === userId);
    res.json(binding || { userId, codeforces: null, atcoder: null, spoj: null, uva: null });
});

app.post('/api/bindings', (req, res) => {
    const db = readDB();
    const { userId, platform, handle } = req.body;
    if (!userId || !platform || !handle) {
        return res.status(400).json({ message: '参数不完整' });
    }
    let binding = db.bindings.find(b => b.userId === userId);
    if (!binding) {
        binding = { userId, codeforces: null, atcoder: null, spoj: null, uva: null };
        db.bindings.push(binding);
    }
    binding[platform] = handle;
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

app.post('/api/submissions', (req, res) => {
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
        submittedAt: new Date().toISOString()
    };
    db.submissions.push(submission);
    writeDB(db);

    // 模拟评测
    setTimeout(() => {
        const result = simulateJudge(submission, db);
        submission.status = result.status;
        submission.executionTime = result.executionTime;
        writeDB(db);
    }, 1000);

    res.status(201).json({ message: '提交成功', submissionId: submission.id });
});

function simulateJudge(submission, db) {
    const random = Math.random();
    let status = 'accepted';
    let executionTime = Math.floor(Math.random() * 500) + 50;
    if (random < 0.3) status = 'wrong_answer';
    else if (random < 0.4) status = 'time_limit_exceeded';
    else if (random < 0.5) status = 'runtime_error';
    return { status, executionTime };
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

// 启动服务器
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});