# Handoff Notes (ZH content annotated in EN)

This repository contains a mix of Chinese (ZH) and English (EN) content.  
The goal of this note is to help US teammates quickly navigate **Chinese filenames / Chinese-only strings** that cannot be commented inline (e.g. JSON), without changing runtime behavior.

## Key Chinese filenames (what they mean)

### Root HTML pages (UI mock/demo)

- `ai语言学习平台-主页.html` = Home page (AI language learning hub)
- `AI语音通话学习模式.html` = AI voice call learning mode (realtime voice + blackboard)
- `笔记本页面.html` = Notebook / saved key points page
- `课程工坊页面.html` = Course workshop page
- `成套课程页面.html` = Course pack page
- `登录页面.html` = Login page
- `设置页面.html` = Settings page
- `我的设置页面.html` = My settings / profile page
- `课程开发者注册.html` = Course developer registration page
- `Linguify 用户信息补全.html` = Linguify user info completion page
- `ai-learning.html` = Simple "AI Language Learning" demo page

### Root Windows scripts (.bat)

- `一键启动服务器.bat` = One-click start server
- `后台启动Realtime服务器.bat` = Start Realtime server (backend)
- `完整启动流程.bat` = Full guided startup flow
- `重启服务器.bat` = Restart server
- `停止所有Node进程.bat` = Stop all Node.js processes
- `检查服务器状态.bat` = Diagnostics / check server status
- `测试启动服务器.bat` = Start server in diagnostic mode
- `启动前端本地服务器.bat` = Start a local static server for frontend pages (needed for mic APIs)
- `设置API密钥.bat` = Write API key into `backend/.env`

### Backend docs

- `backend/接入说明.md` = Integration guide (ZH, now annotated with EN inline)
- `backend/语音对话精简实现路径.md` = Minimal voice-only implementation path (ZH)
- `backend/Voice-Minimal-Path_EN.md` = English translation/annotation of the file above

## Chinese text inside non-commentable files

### `backend/package.json`

- Field: `"description": "实时语音对话后端服务器"`
- EN meaning: "Backend server for realtime voice dialogue"

### `package-lock.json`

If you see Chinese in `package-lock.json`, it is treated as **generated** content.  
We keep it as-is and annotate meaning in docs instead of editing lockfiles.

## Where English annotations live

- Backend Chinese docs have inline `> EN:` annotations:
  - `backend/README.md`
  - `backend/接入说明.md`
- A full EN version is provided for the long reference doc:
  - `backend/Voice-Minimal-Path_EN.md`
- Backend JS files include an `EN GLOSSARY` comment block near the top:
  - `backend/realtime-audio-server.js`
  - `backend/realtime-openai.js`
  - `backend/realtime-voice.js`
  - `backend/check-server.js`
  - `backend/server.js`
- Most HTML pages include a note in `<head>` stating where the `en` i18n dictionary is located (or a small glossary for Chinese-only demo pages like `笔记本页面.html`).

