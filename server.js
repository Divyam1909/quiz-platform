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
    },
    // Optimized for 200+ concurrent users
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowUpgrades: true
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

                // Resend current state
                const currentQuestion = room.currentQuestionIndex < room.poll.questions.length
                    ? room.poll.questions[room.currentQuestionIndex]
                    : null;

                socket.emit('session_restored', {
                    role: 'HOST',
                    roomCode,
                    gameState: room.gameState === 'FINISHED' ? 'OVER' : room.gameState,
                    players: Object.values(room.players),
                    question: currentQuestion ? {
                        text: currentQuestion.text,
                        options: currentQuestion.options
                    } : null,
                    stats: {
                        answersReceived: room.answersReceived,
                        totalPlayers: Object.keys(room.players).length
                    },
                    voteCounts: room.voteCounts || []
                });
                touchRoom(roomCode);
                console.log(`Host reconnected to ${roomCode}`);
            } else {
                socket.emit('session_invalid');
            }
        } else if (type === 'PLAYER') {
            const player = room.players[id];
            if (player) {
                // Player Reconnect
                player.socketId = socket.id;
                socket.join(roomCode);

                // Get current question info
                let currentQuestion = null;
                if (room.gameState === 'QUESTION' || room.gameState === 'ANSWERING') {
                    const question = room.poll.questions[room.currentQuestionIndex];
                    currentQuestion = {
                        questionText: question.text,
                        options: question.options,
                        questionIndex: room.currentQuestionIndex + 1,
                        optionsCount: question.options.length
                    };
                }

                socket.emit('session_restored', {
                    role: 'PLAYER',
                    roomCode,
                    gameState: room.gameState === 'FINISHED' ? 'OVER' : room.gameState,
                    playerName: player.name,
                    currentQuestion,
                    hasVoted: player.hasVotedThisRound
                });
                touchRoom(roomCode);
                console.log(`Player ${player.name} reconnected to ${roomCode}`);
            } else {
                socket.emit('session_invalid');
            }
        }
    });


    // --- HOST EVENTS ---

    socket.on('create_room', (pollData, callback) => {
        const roomCode = generateRoomCode();
        const hostToken = Math.random().toString(36).substring(2) + Date.now().toString(36);

        rooms[roomCode] = {
            hostId: socket.id,
            hostToken,
            gameState: 'LOBBY',
            players: {},
            poll: pollData,
            currentQuestionIndex: 0,
            answersReceived: 0,
            voteCounts: [], // Array of vote counts per option
            playerVotes: {}, // Track which option each player voted for
            lastActivity: Date.now()
        };

        socket.join(roomCode);
        callback({ roomCode, hostToken });
        console.log(`Room created: ${roomCode}`);
    });

    socket.on('start_game', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            touchRoom(roomCode);
            startPoll(roomCode);
        }
    });

    socket.on('next_question', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.currentQuestionIndex += 1;
            if (room.currentQuestionIndex < room.poll.questions.length) {
                sendQuestion(roomCode);
            } else {
                // Poll finished
                room.gameState = 'FINISHED';
                io.to(roomCode).emit('poll_over');
            }
        }
    });

    socket.on('reset_game', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.gameState = 'LOBBY';
            room.currentQuestionIndex = 0;
            room.answersReceived = 0;
            room.voteCounts = [];
            room.playerVotes = {};

            // Reset player vote state
            Object.values(room.players).forEach(p => {
                p.hasVotedThisRound = false;
            });

            io.to(roomCode).emit('game_reset', room.poll.title);
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

        // Prevent host socket from joining as player
        if (socket.id === room.hostId) {
            console.log(`Blocked host socket from joining as player in ${roomCode}`);
            return callback({ error: "Host cannot join as player" });
        }

        if (room.gameState !== 'LOBBY' && !room.players[playerId]) {
            return callback({ error: "Poll in progress" });
        }

        const existingPlayer = Object.values(room.players).find(p => p.name === playerName);
        if (existingPlayer && existingPlayer.id !== playerId) {
            return callback({ error: "Name taken" });
        }

        // Add or update player
        room.players[playerId] = {
            id: playerId,
            socketId: socket.id,
            name: playerName,
            hasVotedThisRound: false
        };

        socket.join(roomCode);
        touchRoom(roomCode);
        io.to(room.hostId).emit('player_joined', Object.values(room.players));

        callback({ success: true, pollTitle: room.poll.title });
        console.log(`${playerName} joined ${roomCode}`);
    });

    socket.on('submit_vote', ({ roomCode, optionIndex, playerId }) => {
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'QUESTION') return;

        const player = room.players[playerId];
        if (!player) return;

        // Prevent double voting
        if (player.hasVotedThisRound) return;
        player.hasVotedThisRound = true;
        room.answersReceived += 1;

        // Track the vote
        if (!room.voteCounts[optionIndex]) {
            room.voteCounts[optionIndex] = 0;
        }
        room.voteCounts[optionIndex] += 1;
        room.playerVotes[playerId] = optionIndex;

        // Calculate how many others selected same option (excluding current player)
        const sameOptionCount = room.voteCounts[optionIndex] - 1;

        // Acknowledge vote to player with same option count
        socket.emit('vote_received', {
            submitted: true,
            sameOptionCount: sameOptionCount
        });

        touchRoom(roomCode);

        // Send live stats to host (efficient: single emit with all data)
        const question = room.poll.questions[room.currentQuestionIndex];
        const totalVotes = room.answersReceived;

        // Build vote data with percentages
        const voteData = question.options.map((opt, idx) => ({
            option: opt,
            count: room.voteCounts[idx] || 0,
            percentage: totalVotes > 0 ? Math.round(((room.voteCounts[idx] || 0) / totalVotes) * 100) : 0
        }));

        io.to(room.hostId).emit('live_votes', {
            answersReceived: room.answersReceived,
            totalPlayers: Object.keys(room.players).length,
            voteData: voteData
        });
    });

    socket.on('disconnect', () => { });
});

// --- HELPERS ---

function startPoll(roomCode) {
    const room = rooms[roomCode];
    room.currentQuestionIndex = 0;
    sendQuestion(roomCode);
}

function sendQuestion(roomCode) {
    const room = rooms[roomCode];
    const question = room.poll.questions[room.currentQuestionIndex];

    room.gameState = 'QUESTION';
    room.answersReceived = 0;
    room.voteCounts = new Array(question.options.length).fill(0);
    room.playerVotes = {};

    Object.values(room.players).forEach(p => p.hasVotedThisRound = false);

    // Host - send question with options
    io.to(room.hostId).emit('new_question_host', {
        question: question.text,
        options: question.options,
        questionIndex: room.currentQuestionIndex + 1,
        totalQuestions: room.poll.questions.length,
        voteData: question.options.map((opt, idx) => ({
            option: opt,
            count: 0,
            percentage: 0
        }))
    });

    // Players - send question
    io.to(roomCode).emit('new_question_player', {
        questionText: question.text,
        options: question.options,
        optionsCount: question.options.length,
        questionIndex: room.currentQuestionIndex + 1
    });

    touchRoom(roomCode);
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Poll Server running on port ${PORT}`);
});