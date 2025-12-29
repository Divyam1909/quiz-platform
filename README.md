# Fun Real-Time Quiz Platform

A fast, reliable, and interactive quiz platform for up to 250+ concurrent players.

## Features
- **Real-time**: Instant score updates and question progression using Socket.io.
- **Scalable**: Optimized for hundreds of concurrent users.
- **Interactive**: Fun UI with live leaderboard and feedback.
- **Easy Customization**: Edit `quiz.json` to change questions.

## Project Structure
- **Frontend**: `App.jsx`, `quiz.json` (React + Vite/CRA)
- **Backend**: `server.js` (Node.js + Express + Socket.io)

## Local Setup

### 1. Prerequisites
You need Node.js installed.

### 2. Backend Setup
1. Create a `package.json` for the backend if not exists:
   ```bash
   npm init -y
   npm install express socket.io cors
   ```
2. Run the server:
   ```bash
   node server.js
   ```
   Server runs on http://localhost:3001

### 3. Frontend Setup
1. Ensure you have a React environment (e.g., Vite):
   ```bash
   npm create vite@latest my-quiz-app -- --template react
   ```
2. Move `App.jsx` and `quiz.json` into `src/`.
3. Install dependencies:
   ```bash
   npm install socket.io-client qrcode.react
   # And ensure tailwindcss is setup
   ```
4. Run the frontend:
   ```bash
   npm run dev
   ```

## Deployment Guide

### Step 1: Deploy Backend (e.g., Railway, Render)
1. Push `server.js` and `package.json` to a GitHub repository.
2. Connect the repo to Railway/Render.
3. It will auto-detect Node.js.
4. Once deployed, **copy the URL** (e.g., `https://my-quiz-backend.up.railway.app`).

### Step 2: Configure Frontend
1. Open `App.jsx`.
2. Locate `const BACKEND_URL` at the top.
3. Replace `'http://localhost:3001'` with your **Deployed Backend URL**.

### Step 3: Deploy Frontend (e.g., Vercel, Netlify)
1. Push your React app (with `App.jsx` and `quiz.json`) to GitHub.
2. Connect the repo to Vercel.
3. Deploy!

## How to Edit the Quiz
To change the questions, you don't need to touch the code logic.

1. Open `quiz.json`.
2. Modify the JSON structure:
   ```json
   {
     "title": "My New Quiz",
     "questions": [
       {
         "text": "New Question?",
         "options": ["Ans1", "Ans2", "Ans3", "Ans4"],
         "correctAnswer": 0, // Index of correct option (0-3)
         "timeLimit": 20
       }
     ]
   }
   ```
3. Save the file.
4. Redeploy the Frontend (or commit & push if using Vercel/Netlify) to apply changes.
