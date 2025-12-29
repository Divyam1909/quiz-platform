const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || "https://quiz-fcrit.vercel.app",
        methods: ["GET", "POST"],
        credentials: true
    }
});

// --- GAME STATE ---
const rooms = {};

// Room Cleanup Config
const ROOM_INACTIVITY_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL = 30 * 60 * 1000; // Run cleanup every 30 minutes

// Helper: Generate 6-digit random code
const generateRoomCode = () => {
    let result = '';
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 6; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
};

// Helper: Update room activity timestamp
const touchRoom = (roomCode) => {
    if (rooms[roomCode]) {
        rooms[roomCode].lastActivity = Date.now();
    }
};

// Periodic Room Cleanup
setInterval(() => {
    const now = Date.now();
    const roomCodes = Object.keys(rooms);

    roomCodes.forEach(code => {
        const room = rooms[code];
        if (now - room.lastActivity > ROOM_INACTIVITY_TIMEOUT) {
            console.log(`Cleaning up inactive room: ${code}`);
            clearInterval(room.timer);
            delete rooms[code];
        }
    });

    if (roomCodes.length > 0) {
        console.log(`Room cleanup: ${roomCodes.length} rooms checked, ${Object.keys(rooms).length} active`);
    }
}, CLEANUP_INTERVAL);

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- RECONNECTION / SYNC ---

    socket.on('check_session', ({ roomCode, type, id /* playerId or hostToken */ }) => {
        const room = rooms[roomCode];
        if (!room) {
            return socket.emit('session_invalid');
        }

        if (type === 'HOST') {
            if (room.hostToken === id) {
                // Host Reconnect
                room.hostId = socket.id;
                socket.join(roomCode);

                // Resend current state (optimized - only current question, not entire quiz)
                const currentQuestion = room.currentQuestionIndex < room.quiz.questions.length
                    ? room.quiz.questions[room.currentQuestionIndex]
                    : null;

                socket.emit('session_restored', {
                    role: 'HOST',
                    roomCode,
                    gameState: room.gameState === 'FINISHED' ? 'OVER' : room.gameState,
                    players: Object.values(room.players),
                    question: currentQuestion ? {
                        text: currentQuestion.text,
                        options: currentQuestion.options,
                        correctAnswer: currentQuestion.correctAnswer,
                        timeLimit: currentQuestion.timeLimit
                    } : null,
                    stats: { answersReceived: room.answersReceived, totalPlayers: Object.keys(room.players).length },
                    leaderboard: room.leaderboard || []
                });
                touchRoom(roomCode);
                console.log(`Host reconnected to ${roomCode}`);
            } else {
                socket.emit('session_invalid');
            }
        } else if (type === 'PLAYER') {
            const player = room.players[id]; // identifying by stable playerId
            if (player) {
                // Player Reconnect
                player.socketId = socket.id;
                socket.join(roomCode);

                // Calculate actual remaining time if in question
                let currentQuestion = null;
                if (room.gameState === 'QUESTION' || room.gameState === 'ANSWERING') {
                    const question = room.quiz.questions[room.currentQuestionIndex];
                    const timeLimit = question.timeLimit || 20;
                    const elapsed = Math.floor((Date.now() - room.questionStartTime) / 1000);
                    const timeRemaining = Math.max(0, timeLimit - elapsed);

                    currentQuestion = {
                        questionText: question.text,
                        options: question.options,
                        questionIndex: room.currentQuestionIndex + 1,
                        optionsCount: question.options.length,
                        timeLimit: timeRemaining, // Send actual remaining time, not original limit
                        startTime: room.questionStartTime
                    };
                }

                socket.emit('session_restored', {
                    role: 'PLAYER',
                    roomCode,
                    gameState: room.gameState === 'FINISHED' ? 'OVER' : room.gameState,
                    playerName: player.name,
                    score: player.score,
                    currentQuestion
                });
                touchRoom(roomCode);
                console.log(`Player ${player.name} reconnected to ${roomCode}`);
            } else {
                socket.emit('session_invalid');
            }
        }
    });


    // --- HOST EVENTS ---

    socket.on('create_room', (quizData, callback) => {
        const roomCode = generateRoomCode();
        const hostToken = Math.random().toString(36).substring(2) + Date.now().toString(36);

        rooms[roomCode] = {
            hostId: socket.id,
            hostToken, // Secret to reclaim host session
            gameState: 'LOBBY',
            players: {}, // Keyed by playerId (stable UUID)
            quiz: quizData,
            currentQuestionIndex: 0,
            timer: null,
            answersReceived: 0,
            leaderboard: [],
            lastActivity: Date.now() // Track room activity for cleanup
        };

        socket.join(roomCode);
        callback({ roomCode, hostToken });
        console.log(`Room created: ${roomCode}`);
    });

    socket.on('start_game', (roomCode) => {
        const room = rooms[roomCode];
        // Security check: ensure caller is owner (or reconnected owner)
        if (room && room.hostId === socket.id) {
            touchRoom(roomCode);
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
                const fullLeaderboard = calculateFullLeaderboard(room);
                const top5 = fullLeaderboard.slice(0, 5);
                room.leaderboard = fullLeaderboard; // Store full for refresh

                // Send full leaderboard to host
                io.to(room.hostId).emit('game_over', { leaderboard: fullLeaderboard, isHost: true });

                // Send personalized data to each player
                Object.values(room.players).forEach(player => {
                    const playerRank = fullLeaderboard.findIndex(p => p.id === player.id) + 1;
                    io.to(player.socketId).emit('game_over', {
                        leaderboard: top5,
                        playerRank,
                        playerScore: player.score,
                        totalPlayers: fullLeaderboard.length,
                        isHost: false
                    });
                });
            }
        }
    });

    socket.on('show_leaderboard', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.gameState = 'LEADERBOARD';
            const board = calculateFullLeaderboard(room).slice(0, 5);
            room.leaderboard = board;
            io.to(roomCode).emit('show_leaderboard', board);
        }
    });

    socket.on('reset_game', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.gameState = 'LOBBY';
            room.currentQuestionIndex = 0;
            room.answersReceived = 0;
            room.leaderboard = [];

            // Reset player scores for new game
            Object.values(room.players).forEach(p => {
                p.score = 0;
                p.streak = 0;
                p.lastAnswerTime = 0;
                p.hasAnsweredThisRound = false;
            });

            io.to(roomCode).emit('game_reset', room.quiz.title);
        }
    });

    socket.on('close_room', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            delete rooms[roomCode];
            io.to(roomCode).emit('room_closed');
        }
    });

    // --- PLAYER EVENTS ---

    socket.on('join_room', ({ roomCode, playerName, playerId }, callback) => {
        const room = rooms[roomCode];

        if (!room) return callback({ error: "Room not found" });
        if (room.gameState !== 'LOBBY' && !room.players[playerId]) {
            return callback({ error: "Game in progress" });
        }

        const existingPlayer = Object.values(room.players).find(p => p.name === playerName);
        if (existingPlayer && existingPlayer.id !== playerId) {
            return callback({ error: "Name taken" });
        }

        room.players[playerId] = {
            id: playerId,
            socketId: socket.id,
            name: playerName,
            score: 0,
            streak: 0,
            lastAnswerTime: 0,
            hasAnsweredThisRound: false
        };

        socket.join(roomCode);
        touchRoom(roomCode);
        io.to(room.hostId).emit('player_joined', Object.values(room.players));

        callback({ success: true, quizTitle: room.quiz.title });
        console.log(`${playerName} joined ${roomCode}`);
    });

    socket.on('submit_answer', ({ roomCode, answerIndex, timeRemaining, playerId }) => {
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'QUESTION') return;

        const player = room.players[playerId];
        if (!player) return;

        const question = room.quiz.questions[room.currentQuestionIndex];
        const isCorrect = question.correctAnswer === answerIndex;

        if (player.hasAnsweredThisRound) return;
        player.hasAnsweredThisRound = true;
        room.answersReceived += 1;

        let points = 0;
        if (isCorrect) {
            const timeLimit = question.timeLimit || 20;
            const safeTime = Math.min(timeRemaining, timeLimit);
            // Formula already present
            points = Math.round(600 + (400 * (safeTime / timeLimit)));
            player.score += points;
            player.streak += 1;
        } else {
            player.streak = 0;
        }

        socket.emit('answer_received', { submitted: true });
        touchRoom(roomCode);
        io.to(room.hostId).emit('live_stats', {
            answersReceived: room.answersReceived,
            totalPlayers: Object.keys(room.players).length
        });

        if (room.answersReceived === Object.keys(room.players).length) {
            endQuestion(roomCode);
        }
    });

    socket.on('disconnect', () => { });
});

// --- HELPERS ---

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
    room.questionStartTime = Date.now();

    Object.values(room.players).forEach(p => p.hasAnsweredThisRound = false);

    // Host
    io.to(room.hostId).emit('new_question_host', {
        question: question.text,
        timeLimit: question.timeLimit || 20,
        options: question.options,
        questionIndex: room.currentQuestionIndex + 1,
        totalQuestions: room.quiz.questions.length
    });

    // Players - Send to all players in room (host is also in room but won't use this event)
    // Note: io.to(roomCode) sends to everyone in the room including host
    // The host client simply ignores player-specific events, which is fine for simplicity
    io.to(roomCode).emit('new_question_player', {
        questionText: question.text,
        options: question.options,
        optionsCount: question.options.length,
        timeLimit: question.timeLimit || 20,
        questionIndex: room.currentQuestionIndex + 1
    });

    let timeLeft = question.timeLimit || 20;
    room.timeRemaining = timeLeft;
    clearInterval(room.timer);
    touchRoom(roomCode);

    room.timer = setInterval(() => {
        room.timeRemaining--;
        touchRoom(roomCode);
        if (room.timeRemaining <= 0) {
            endQuestion(roomCode);
        }
    }, 1000);
}

function endQuestion(roomCode) {
    const room = rooms[roomCode];
    clearInterval(room.timer);
    room.gameState = 'RESULT';

    const question = room.quiz.questions[room.currentQuestionIndex];

    io.to(roomCode).emit('question_ended', {
        correctAnswer: question.correctAnswer
    });
}

function calculateFullLeaderboard(room) {
    return Object.values(room.players)
        .sort((a, b) => b.score - a.score);
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});