const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- GAME STATE ---
const rooms = {};

// Helper: Generate 6-digit random code
const generateRoomCode = () => {
    let result = '';
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 6; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
};

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

                // Resend current full state
                socket.emit('session_restored', {
                    role: 'HOST',
                    roomCode,
                    gameState: room.gameState,
                    players: Object.values(room.players),
                    question: room.currentQuestionIndex < room.quiz.questions.length ? room.quiz.questions[room.currentQuestionIndex] : null,
                    stats: { answersReceived: room.answersReceived, totalPlayers: Object.keys(room.players).length },
                    leaderboard: room.leaderboard || []
                });
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

                socket.emit('session_restored', {
                    role: 'PLAYER',
                    roomCode,
                    gameState: room.gameState,
                    playerName: player.name,
                    score: player.score,
                    // If in question, send question data
                    currentQuestion: room.gameState === 'QUESTION' || room.gameState === 'ANSWERING' ? {
                        questionIndex: room.currentQuestionIndex + 1,
                        optionsCount: room.quiz.questions[room.currentQuestionIndex].options.length,
                        timeLimit: room.quiz.questions[room.currentQuestionIndex].timeLimit, // Should calc remaining but ok for now
                        startTime: room.questionStartTime
                    } : null
                });
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
            leaderboard: []
        };

        socket.join(roomCode);
        callback({ roomCode, hostToken });
        console.log(`Room created: ${roomCode}`);
    });

    socket.on('start_game', (roomCode) => {
        const room = rooms[roomCode];
        // Security check: ensure caller is owner (or reconnected owner)
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
                const finalLeaderboard = calculateLeaderboard(room);
                room.leaderboard = finalLeaderboard; // Store for refresh
                io.to(roomCode).emit('game_over', finalLeaderboard);
            }
        }
    });

    socket.on('show_leaderboard', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.gameState = 'LEADERBOARD';
            const board = calculateLeaderboard(room);
            room.leaderboard = board;
            io.to(roomCode).emit('show_leaderboard', board);
        }
    });

    // --- PLAYER EVENTS ---

    socket.on('join_room', ({ roomCode, playerName, playerId }, callback) => {
        const room = rooms[roomCode];

        if (!room) return callback({ error: "Room not found" });
        if (room.gameState !== 'LOBBY' && !room.players[playerId]) {
            // Allow rejoin if specifically known, but not new joiners mid-game (simplification)
            return callback({ error: "Game in progress" });
        }

        // Check rename or rejoin
        const existingPlayer = Object.values(room.players).find(p => p.name === playerName);

        // If name exists AND it's not THIS player trying to reconnect
        if (existingPlayer && existingPlayer.id !== playerId) {
            return callback({ error: "Name taken" });
        }

        // Add or Update Player
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
        io.to(room.hostId).emit('player_joined', Object.values(room.players));

        callback({ success: true, quizTitle: room.quiz.title });
        console.log(`${playerName} joined ${roomCode}`);
    });

    socket.on('submit_answer', ({ roomCode, answerIndex, timeRemaining, playerId }) => {
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'QUESTION') return;

        // Use playerId to look up player
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
            points = Math.round(600 + (400 * (safeTime / timeLimit)));
            player.score += points;
            player.streak += 1;
        } else {
            player.streak = 0;
        }

        // Send individual result
        socket.emit('answer_received', { submitted: true });

        // Notify host
        io.to(room.hostId).emit('live_stats', {
            answersReceived: room.answersReceived,
            totalPlayers: Object.keys(room.players).length
        });

        // Auto Advance
        if (room.answersReceived === Object.keys(room.players).length) {
            endQuestion(roomCode);
        }
    });

    socket.on('disconnect', () => {
        // We do NOT remove players on disconnect anymore to allow refresh
        // They stay in the room.players object
    });
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
    room.questionStartTime = Date.now(); // Sync time

    Object.values(room.players).forEach(p => p.hasAnsweredThisRound = false);

    // Host
    io.to(room.hostId).emit('new_question_host', {
        question: question.text,
        timeLimit: question.timeLimit || 20,
        options: question.options,
        questionIndex: room.currentQuestionIndex + 1,
        totalQuestions: room.quiz.questions.length
    });

    // Players
    io.to(roomCode).emit('new_question_player', {
        optionsCount: question.options.length,
        timeLimit: question.timeLimit || 20,
        questionIndex: room.currentQuestionIndex + 1
    });

    // Timer
    let timeLeft = question.timeLimit || 20;
    room.timeRemaining = timeLeft;
    clearInterval(room.timer);

    room.timer = setInterval(() => {
        room.timeRemaining--;
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

function calculateLeaderboard(room) {
    return Object.values(room.players)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});