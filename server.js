/**
 * QUIZ PLATFORM BACKEND
 * * Deployment Instructions (Railway):
 * 1. Create a new repository with this file and a package.json.
 * 2. package.json dependencies: "express", "socket.io", "cors".
 * 3. Deploy to Railway.
 * 4. Copy the provided Railway domain (e.g., https://my-quiz.railway.app) to the Frontend config.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

// Configure Socket.io with CORS to allow connections from your Vercel frontend
const io = new Server(server, {
    cors: {
        origin: "*", // In production, replace with your Vercel URL for security
        methods: ["GET", "POST"]
    }
});

// --- GAME STATE MANAGEMENT ---
// In a real production app for >10,000 users, use Redis. 
// For 300 users, native JS objects are incredibly fast and sufficient.

const rooms = {};
// Structure:
// rooms[roomCode] = {
//   hostId: string,
//   gameState: 'LOBBY' | 'QUESTION' | 'LEADERBOARD' | 'FINISHED',
//   players: { [socketId]: { name, score, streaks, lastAnswerTime } },
//   quiz: { title, questions: [] },
//   currentQuestionIndex: 0,
//   timer: null,
//   timeRemaining: 0
// }

// Helper: Generate 6-digit random code
const generateRoomCode = () => {
    let result = '';
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I, 1, O, 0 to avoid confusion
    for (let i = 0; i < 6; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- HOST EVENTS ---

    socket.on('create_room', (quizData, callback) => {
        const roomCode = generateRoomCode();

        rooms[roomCode] = {
            hostId: socket.id,
            gameState: 'LOBBY',
            players: {},
            quiz: quizData,
            currentQuestionIndex: 0,
            timer: null,
            timeRemaining: 0,
            answersReceived: 0
        };

        socket.join(roomCode);
        callback({ roomCode });
        console.log(`Room created: ${roomCode} by ${socket.id}`);
    });

    socket.on('start_game', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            startGame(roomCode);
        }
    });

    socket.on('next_question', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.currentQuestionIndex += 1;

            if (room.currentQuestionIndex < room.quiz.questions.length) {
                sendQuestion(roomCode);
            } else {
                room.gameState = 'FINISHED';
                io.to(roomCode).emit('game_over', calculateLeaderboard(room));
            }
        }
    });

    socket.on('show_leaderboard', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.gameState = 'LEADERBOARD';
            io.to(roomCode).emit('show_leaderboard', calculateLeaderboard(room));
        }
    });

    // --- PLAYER EVENTS ---

    socket.on('join_room', ({ roomCode, playerName }, callback) => {
        const room = rooms[roomCode];

        if (!room) {
            return callback({ error: "Room not found" });
        }
        if (room.gameState !== 'LOBBY') {
            return callback({ error: "Game already started" });
        }

        // Check for duplicate names
        const nameExists = Object.values(room.players).some(p => p.name === playerName);
        if (nameExists) {
            return callback({ error: "Name taken, choose another" });
        }

        // Add player
        room.players[socket.id] = {
            name: playerName,
            score: 0,
            streak: 0,
            lastAnswerTime: 0
        };

        socket.join(roomCode);

        // Notify host of new player
        io.to(room.hostId).emit('player_joined', Object.values(room.players));

        callback({ success: true, quizTitle: room.quiz.title });
        console.log(`${playerName} joined ${roomCode}`);
    });

    socket.on('submit_answer', ({ roomCode, answerIndex, timeRemaining }) => {
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'QUESTION') return;

        const player = room.players[socket.id];
        if (!player) return;

        const question = room.quiz.questions[room.currentQuestionIndex];
        const isCorrect = question.correctAnswer === answerIndex;

        // Prevent double submission
        if (player.hasAnsweredThisRound) return;
        player.hasAnsweredThisRound = true;
        room.answersReceived += 1;

        // Calculate Score (Base 1000 + Time Bonus)
        // Formula: 1000 * (1 - (TimeTaken / TotalTime) / 2)
        // Simply: More time remaining = Higher score.
        let points = 0;
        if (isCorrect) {
            const timeLimit = question.timeLimit || 20;
            // Ensure timeRemaining doesn't exceed limit logic
            const safeTime = Math.min(timeRemaining, timeLimit);
            points = Math.round(600 + (400 * (safeTime / timeLimit)));

            player.score += points;
            player.streak += 1;
        } else {
            player.streak = 0;
        }

        // Send individual result to player immediately (waiting screen)
        socket.emit('answer_received', {
            submitted: true
        });

        // Notify host of progress
        io.to(room.hostId).emit('live_stats', {
            answersReceived: room.answersReceived,
            totalPlayers: Object.keys(room.players).length
        });

        // If everyone answered, end question early
        if (room.answersReceived === Object.keys(room.players).length) {
            endQuestion(roomCode);
        }
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        // Ideally handle cleanup. For now, we keep players in state 
        // in case they reconnect (not implemented in this simple version)
        // or to keep their score on the board.

        // If host disconnects, maybe pause game? 
        // For MVP, we ignore it.
    });
});

// --- GAME LOGIC HELPERS ---

function startGame(roomCode) {
    const room = rooms[roomCode];
    room.currentQuestionIndex = 0;
    sendQuestion(roomCode);
}

function sendQuestion(roomCode) {
    const room = rooms[roomCode];
    const question = room.quiz.questions[room.currentQuestionIndex];

    room.gameState = 'QUESTION';
    room.answersReceived = 0;

    // Reset player answer flags
    Object.values(room.players).forEach(p => p.hasAnsweredThisRound = false);

    // Send question payload to Host
    io.to(room.hostId).emit('new_question_host', {
        question: question.text,
        timeLimit: question.timeLimit || 20,
        options: question.options,
        questionIndex: room.currentQuestionIndex + 1,
        totalQuestions: room.quiz.questions.length
    });

    // Send question payload to Players (HIDDEN ANSWER)
    io.to(roomCode).emit('new_question_player', {
        optionsCount: question.options.length,
        timeLimit: question.timeLimit || 20,
        questionIndex: room.currentQuestionIndex + 1
    });

    // Start Timer
    let timeLeft = question.timeLimit || 20;
    room.timeRemaining = timeLeft;

    clearInterval(room.timer);
    room.timer = setInterval(() => {
        timeLeft--;
        room.timeRemaining = timeLeft;

        if (timeLeft <= 0) {
            endQuestion(roomCode);
        }
    }, 1000);
}

function endQuestion(roomCode) {
    const room = rooms[roomCode];
    clearInterval(room.timer);
    room.gameState = 'RESULT'; // Intermediate state before leaderboard

    const question = room.quiz.questions[room.currentQuestionIndex];

    // Notify everyone
    io.to(roomCode).emit('question_ended', {
        correctAnswer: question.correctAnswer
    });

    // Calculate specific feedback for host
    io.to(room.hostId).emit('question_stats', {
        // Could send detailed breakdown here
    });
}

function calculateLeaderboard(room) {
    const sortedPlayers = Object.values(room.players)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5); // Top 5

    return sortedPlayers;
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});