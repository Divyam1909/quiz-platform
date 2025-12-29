import http from 'k6/http';
import { check, sleep } from 'k6';
import ws from 'k6/ws';

export const options = {
    stages: [
        { duration: '30s', target: 50 },
        { duration: '1m', target: 150 },
        { duration: '1m', target: 200 },
        { duration: '1m', target: 200 },
        { duration: '30s', target: 0 },
    ],
};

const BACKEND_URL = 'https://quiz-platform-production-949c.up.railway.app';
const ROOM_CODE = 'F37GA9';

export default function () {
    const playerId = `player_${__VU}_${__ITER}`;
    const playerName = `TestPlayer${__VU}`;

    const url = `wss://quiz-platform-production-949c.up.railway.app/socket.io/?EIO=4&transport=websocket`;

    const res = ws.connect(url, {}, function (socket) {
        socket.on('open', () => {
            console.log('Connected');

            // Socket.io handshake
            socket.send('40');

            // Join room
            socket.setTimeout(() => {
                const joinMsg = `42${JSON.stringify(['join_room', {
                    roomCode: ROOM_CODE,
                    playerName: playerName,
                    playerId: playerId
                }])}`;
                socket.send(joinMsg);
            }, 100);
        });

        socket.on('message', (data) => {
            console.log(`Received: ${data}`);

            // If we receive a question, answer it
            if (data.includes('new_question_player')) {
                socket.setTimeout(() => {
                    const answerMsg = `42${JSON.stringify(['submit_answer', {
                        roomCode: ROOM_CODE,
                        answerIndex: Math.floor(Math.random() * 4),
                        timeRemaining: Math.floor(Math.random() * 8) + 2,
                        playerId: playerId
                    }])}`;
                    socket.send(answerMsg);
                }, 500);
            }
        });

        socket.on('error', (e) => {
            console.error('Error:', e);
        });

        // Keep connection open for 30 seconds
        socket.setTimeout(() => {
            socket.close();
        }, 30000);
    });

    check(res, { 'status is 101': (r) => r && r.status === 101 });
}
