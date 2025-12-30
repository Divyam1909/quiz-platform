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
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowUpgrades: true
});

// --- GAME STATE ---
const rooms = {};

// Room Cleanup Config
const ROOM_INACTIVITY_TIMEOUT = 2 * 60 * 60 * 1000;
const CLEANUP_INTERVAL = 30 * 60 * 1000;

// Helper: Generate 6-digit random code
const generateRoomCode = () => {
    let result = '';
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 6; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
};

// Helper: Generate random avatar (1-20 preset avatars)
const generateAvatar = () => Math.floor(Math.random() * 20) + 1;

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
            if (room.timer) clearInterval(room.timer);
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
    socket.on('check_session', ({ roomCode, type, id }) => {
        const room = rooms[roomCode];
        if (!room) {
            return socket.emit('session_invalid');
        }

        if (type === 'HOST') {
            if (room.hostToken === id) {
                room.hostId = socket.id;
                socket.join(roomCode);

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
                    voteCounts: room.voteCounts || [],
                    timerDuration: room.timerDuration,
                    emojiCounts: room.emojiCounts || {}
                });
                touchRoom(roomCode);
                console.log(`Host reconnected to ${roomCode}`);
            } else {
                socket.emit('session_invalid');
            }
        } else if (type === 'PLAYER') {
            const player = room.players[id];
            if (player) {
                player.socketId = socket.id;
                socket.join(roomCode);

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
                    avatar: player.avatar,
                    currentQuestion,
                    hasVoted: player.hasVotedThisRound,
                    timeRemaining: room.timeRemaining || 0
                });
                touchRoom(roomCode);
                console.log(`Player ${player.name} reconnected to ${roomCode}`);
            } else {
                socket.emit('session_invalid');
            }
        }
    });

    // --- HOST EVENTS ---
    socket.on('create_room', ({ pollData, timerDuration }, callback) => {
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
            voteCounts: [],
            playerVotes: {},
            emojiCounts: {},
            playerEmojis: {},
            timerDuration: timerDuration || 0, // 0 = no timer
            timer: null,
            timeRemaining: 0,
            lastActivity: Date.now()
        };

        socket.join(roomCode);
        callback({ roomCode, hostToken });
        console.log(`Room created: ${roomCode} with timer: ${timerDuration || 'none'}`);
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
            if (room.timer) clearInterval(room.timer);
            room.currentQuestionIndex += 1;
            if (room.currentQuestionIndex < room.poll.questions.length) {
                sendQuestion(roomCode);
            } else {
                room.gameState = 'FINISHED';
                io.to(roomCode).emit('poll_over');
            }
        }
    });

    socket.on('reset_game', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            if (room.timer) clearInterval(room.timer);
            room.gameState = 'LOBBY';
            room.currentQuestionIndex = 0;
            room.answersReceived = 0;
            room.voteCounts = [];
            room.playerVotes = {};
            room.emojiCounts = {};
            room.playerEmojis = {};

            Object.values(room.players).forEach(p => {
                p.hasVotedThisRound = false;
                p.hasReactedThisRound = false;
            });

            io.to(roomCode).emit('game_reset', room.poll.title);
        }
    });

    socket.on('close_room', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            if (room.timer) clearInterval(room.timer);
            delete rooms[roomCode];
            io.to(roomCode).emit('room_closed');
        }
    });

    // --- PLAYER EVENTS ---
    socket.on('join_room', ({ roomCode, playerName, playerId }, callback) => {
        const room = rooms[roomCode];

        if (!room) return callback({ error: "Room not found" });

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

        const avatar = room.players[playerId]?.avatar || generateAvatar();

        room.players[playerId] = {
            id: playerId,
            socketId: socket.id,
            name: playerName,
            avatar: avatar,
            hasVotedThisRound: false,
            hasReactedThisRound: false
        };

        socket.join(roomCode);
        touchRoom(roomCode);
        io.to(room.hostId).emit('player_joined', Object.values(room.players));

        callback({ success: true, pollTitle: room.poll.title, avatar: avatar });
        console.log(`${playerName} (avatar ${avatar}) joined ${roomCode}`);
    });

    socket.on('submit_vote', ({ roomCode, optionIndex, playerId }) => {
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'QUESTION') return;

        const player = room.players[playerId];
        if (!player) return;

        if (player.hasVotedThisRound) return;
        player.hasVotedThisRound = true;
        room.answersReceived += 1;

        if (!room.voteCounts[optionIndex]) {
            room.voteCounts[optionIndex] = 0;
        }
        room.voteCounts[optionIndex] += 1;
        room.playerVotes[playerId] = optionIndex;

        const sameOptionCount = room.voteCounts[optionIndex] - 1;

        socket.emit('vote_received', {
            submitted: true,
            sameOptionCount: sameOptionCount
        });

        touchRoom(roomCode);

        const question = room.poll.questions[room.currentQuestionIndex];
        const totalVotes = room.answersReceived;

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

    // --- EMOJI REACTIONS (1 per user per question, host only) ---
    socket.on('submit_emoji', ({ roomCode, emoji, playerId }) => {
        const room = rooms[roomCode];
        if (!room || room.gameState !== 'QUESTION') return;

        const player = room.players[playerId];
        if (!player || !player.hasVotedThisRound) return; // Must vote first
        if (player.hasReactedThisRound) return; // Only 1 emoji per question

        player.hasReactedThisRound = true;

        if (!room.emojiCounts[emoji]) {
            room.emojiCounts[emoji] = 0;
        }
        room.emojiCounts[emoji] += 1;
        room.playerEmojis[playerId] = emoji;

        // Only send to host
        io.to(room.hostId).emit('emoji_update', {
            emojiCounts: room.emojiCounts,
            newEmoji: emoji,
            playerName: player.name
        });

        socket.emit('emoji_received');
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
    room.emojiCounts = {};
    room.playerEmojis = {};

    Object.values(room.players).forEach(p => {
        p.hasVotedThisRound = false;
        p.hasReactedThisRound = false;
    });

    // Host - send question with options
    io.to(room.hostId).emit('new_question_host', {
        question: question.text,
        options: question.options,
        questionIndex: room.currentQuestionIndex + 1,
        totalQuestions: room.poll.questions.length,
        voteData: question.options.map((opt) => ({
            option: opt,
            count: 0,
            percentage: 0
        })),
        timerDuration: room.timerDuration
    });

    // Players - send question
    io.to(roomCode).emit('new_question_player', {
        questionText: question.text,
        options: question.options,
        optionsCount: question.options.length,
        questionIndex: room.currentQuestionIndex + 1,
        timerDuration: room.timerDuration
    });

    touchRoom(roomCode);

    // Start timer if configured
    if (room.timerDuration > 0) {
        room.timeRemaining = room.timerDuration;

        room.timer = setInterval(() => {
            room.timeRemaining -= 1;

            // Broadcast timer to all
            io.to(roomCode).emit('timer_tick', room.timeRemaining);

            if (room.timeRemaining <= 0) {
                clearInterval(room.timer);
                room.timer = null;
                // Auto-advance to next question
                room.currentQuestionIndex += 1;
                if (room.currentQuestionIndex < room.poll.questions.length) {
                    sendQuestion(roomCode);
                } else {
                    room.gameState = 'FINISHED';
                    io.to(roomCode).emit('poll_over');
                }
            }
        }, 1000);
    }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Poll Server running on port ${PORT}`);
});