import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react';
import quizData from './quiz.json';

// --- CONFIGURATION ---
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

// --- HELPERS ---
const generateId = () => Math.random().toString(36).substr(2, 9);
const getSession = () => JSON.parse(sessionStorage.getItem('quiz_session')) || {};
const setSession = (data) => sessionStorage.setItem('quiz_session', JSON.stringify({ ...getSession(), ...data }));

// --- ICONS & ASSETS ---
const Shapes = {
    0: (className) => <div className={`w-full h-full bg-red-500 clip-triangle ${className}`}>▲</div>,
    1: (className) => <div className={`w-full h-full bg-blue-500 ${className}`}>●</div>, // Circle
    2: (className) => <div className={`w-full h-full bg-yellow-500 ${className}`}>■</div>, // Square
    3: (className) => <div className={`w-full h-full bg-green-500 ${className}`}>★</div> // Star
};
const Colors = ['bg-red-500', 'bg-blue-500', 'bg-yellow-500', 'bg-green-500'];

export default function App() {
    const [socket, setSocket] = useState(null);
    const [view, setView] = useState('LANDING');
    const [role, setRole] = useState(null);
    const [connectionError, setConnectionError] = useState(false);

    // Shared State
    const [roomCode, setRoomCode] = useState('');
    const [playerName, setPlayerName] = useState('');
    const [myId, setMyId] = useState(null); // Stable Player ID

    // Host State
    const [players, setPlayers] = useState([]);
    const [hostQuestion, setHostQuestion] = useState(null);
    const [liveStats, setLiveStats] = useState({ answersReceived: 0, totalPlayers: 0 });
    const [leaderboard, setLeaderboard] = useState([]);
    const [gameStatus, setGameStatus] = useState('LOBBY');

    // Player State
    const [playerGameState, setPlayerGameState] = useState('WAITING');
    const [playerQuestion, setPlayerQuestion] = useState(null);
    const [playerResult, setPlayerResult] = useState(null);
    const [timer, setTimer] = useState(0);
    const [myAnswer, setMyAnswer] = useState(null);

    // --- INITIALIZATION & RECONNECT ---
    useEffect(() => {
        // 1. Get or Create Stable ID
        let storedId = localStorage.getItem('quiz_player_id');
        if (!storedId) {
            storedId = generateId();
            localStorage.setItem('quiz_player_id', storedId);
        }
        setMyId(storedId);

        // 2. Check URL for PIN
        const params = new URLSearchParams(window.location.search);
        const urlPin = params.get('pin');
        if (urlPin) setRoomCode(urlPin);

        // 3. Connect Socket
        const newSocket = io(BACKEND_URL);
        setSocket(newSocket);

        newSocket.on('connect', () => {
            setConnectionError(false);
            // 4. Attempt Reconnect
            const session = getSession();
            if (session.roomCode && session.role) {
                newSocket.emit('check_session', {
                    roomCode: session.roomCode,
                    type: session.role,
                    id: session.role === 'HOST' ? session.hostToken : storedId
                });
            }
        });

        newSocket.on('connect_error', () => setConnectionError(true));

        return () => newSocket.close();
    }, []);

    useEffect(() => {
        if (!socket) return;

        // --- SESSION RESTORE ---
        socket.on('session_restored', (data) => {
            console.log('Session Restored:', data);
            setRole(data.role);
            setRoomCode(data.roomCode);
            setGameStatus(data.gameState); // Mostly for host

            if (data.role === 'HOST') {
                setView(data.gameState === 'LOBBY' ? 'HOST_LOBBY' : 'HOST_GAME');
                setPlayers(data.players || []);
                if (data.gameState === 'QUESTION') {
                    setHostQuestion({
                        question: data.question.text,
                        timeLimit: data.question.timeLimit,
                        questionIndex: 1, // Approximation for restore
                        totalQuestions: 10,
                        options: data.question.options
                    });
                }
            } else {
                setView('PLAYER_GAME');
                setPlayerName(data.playerName);
                if (data.gameState === 'QUESTION' || data.gameState === 'ANSWERING') {
                    setPlayerGameState('ANSWERING');
                    setPlayerQuestion(data.currentQuestion);
                    setTimer(data.currentQuestion.timeLimit); // Should be calc'd
                } else if (data.gameState === 'LOBBY') {
                    setPlayerGameState('WAITING');
                }
            }
        });

        socket.on('session_invalid', () => {
            sessionStorage.removeItem('quiz_session');
            setView('LANDING');
        });

        // --- HOST LISTENERS ---
        socket.on('player_joined', (updatedPlayers) => setPlayers(updatedPlayers));
        socket.on('new_question_host', (data) => {
            setHostQuestion(data);
            setGameStatus('QUESTION');
            setView('HOST_GAME');
            setLiveStats({ answersReceived: 0, totalPlayers: players.length });
        });
        socket.on('live_stats', (stats) => setLiveStats(prev => ({ ...prev, ...stats })));
        socket.on('question_ended', () => setGameStatus('RESULT'));
        socket.on('show_leaderboard', (data) => {
            setLeaderboard(data);
            setGameStatus('LEADERBOARD');
        });
        socket.on('game_over', (finalLeaderboard) => {
            setLeaderboard(finalLeaderboard);
            setGameStatus('OVER');
        });

        // --- PLAYER LISTENERS ---
        socket.on('new_question_player', (data) => {
            setPlayerQuestion(data);
            setPlayerGameState('ANSWERING');
            setTimer(data.timeLimit);
            setMyAnswer(null);
            setPlayerResult(null);
        });
        socket.on('answer_received', () => setPlayerGameState('SUBMITTED'));
        socket.on('question_ended', (data) => {
            setPlayerGameState('RESULT');
            setPlayerResult(data);
        });

    }, [socket, players.length]);

    // Timer Effect
    useEffect(() => {
        if (timer > 0 && playerGameState === 'ANSWERING') {
            const interval = setInterval(() => setTimer(t => t - 1), 1000);
            return () => clearInterval(interval);
        }
    }, [timer, playerGameState]);


    // --- ACTIONS ---

    const handleCreateQuiz = () => {
        socket.emit('create_room', quizData, (response) => {
            setRoomCode(response.roomCode);
            setRole('HOST');
            setView('HOST_LOBBY');
            setPlayers([]);
            // Save Session
            setSession({ role: 'HOST', roomCode: response.roomCode, hostToken: response.hostToken });
        });
    };

    const handleStartGame = () => {
        if (socket) socket.emit('start_game', roomCode);
    };

    const handleNextQuestion = () => socket.emit('next_question', roomCode);
    const handleShowLeaderboard = () => socket.emit('show_leaderboard', roomCode);

    const handleJoinRoom = () => {
        if (!roomCode || !playerName) return alert("Please enter code and name");

        socket.emit('join_room', {
            roomCode: roomCode.toUpperCase(),
            playerName,
            playerId: myId
        }, (response) => {
            if (response.error) {
                alert(response.error);
            } else {
                setRole('PLAYER');
                setView('PLAYER_GAME');
                // Save Session
                setSession({ role: 'PLAYER', roomCode: roomCode.toUpperCase() });
            }
        });
    };

    const handleSubmitAnswer = (index) => {
        if (playerGameState !== 'ANSWERING') return;
        setMyAnswer(index);
        socket.emit('submit_answer', {
            roomCode,
            answerIndex: index,
            timeRemaining: timer,
            playerId: myId
        });
    };


    // --- VIEWS ---

    if (connectionError) return <div className="p-10 text-center text-red-600 font-bold">Connecting to server...</div>;

    if (view === 'LANDING') {
        return (
            <div className="min-h-screen bg-indigo-900 flex flex-col items-center justify-center text-white p-4 font-sans">
                <h1 className="text-6xl font-black mb-8 tracking-tighter transform -rotate-2">QUIZ<span className="text-yellow-400">MASTER</span></h1>
                <div className="bg-white text-gray-800 p-8 rounded-2xl shadow-2xl w-full max-w-md space-y-6">
                    <div className="space-y-4">
                        <input
                            type="text"
                            placeholder="GAME PIN"
                            className="w-full text-center text-3xl p-4 border-b-4 border-gray-300 rounded-lg focus:border-indigo-600 focus:outline-none uppercase tracking-[0.2em] font-black bg-gray-50 placeholder-gray-300"
                            value={roomCode}
                            onChange={e => setRoomCode(e.target.value)}
                            maxLength={6}
                        />
                        <input
                            type="text"
                            placeholder="Enter Nickname"
                            className="w-full text-center text-xl p-4 border-2 border-gray-200 rounded-lg focus:border-indigo-600 focus:outline-none font-bold"
                            value={playerName}
                            onChange={e => setPlayerName(e.target.value)}
                        />
                        <button onClick={handleJoinRoom} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black py-4 rounded-xl shadow-lg transform transition active:scale-95 text-xl">
                            JOIN GAME
                        </button>
                    </div>
                    <div className="border-t border-gray-100 pt-6 text-center">
                        <button onClick={handleCreateQuiz} className="text-gray-400 hover:text-indigo-600 font-bold text-sm underline">
                            Host a Quiz
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (view === 'HOST_LOBBY') {
        const joinUrl = `${window.location.origin}?pin=${roomCode}`;

        return (
            <div className="min-h-screen bg-slate-900 text-white p-6 flex flex-col font-sans">
                {/* Header */}
                <div className="flex flex-col md:flex-row justify-between items-center bg-slate-800 p-6 rounded-2xl shadow-xl mb-8 border border-slate-700">
                    <div>
                        <p className="text-slate-400 font-bold uppercase tracking-widest text-sm mb-2">Join at {window.location.hostname}</p>
                        <div className="flex items-center gap-4">
                            <div className="bg-indigo-600 px-6 py-2 rounded-lg shadow-lg">
                                <span className="text-sm font-bold block text-indigo-200 uppercase">Current PIN</span>
                                <span className="text-5xl font-black tracking-widest font-mono">{roomCode}</span>
                            </div>
                        </div>
                    </div>
                    <div className="mt-4 md:mt-0 bg-white p-3 rounded-xl shadow-inner">
                        <QRCodeSVG value={joinUrl} size={140} />
                    </div>
                </div>

                {/* Player Grid */}
                <div className="flex-1">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-3xl font-black flex items-center gap-3">
                            <span className="bg-green-500 text-white px-3 py-1 rounded-lg text-lg">{players.length}</span>
                            Waiting for Players...
                        </h2>
                    </div>

                    {players.length === 0 ? (
                        <div className="text-center py-20 opacity-30 text-2xl font-bold italic">
                            Waiting for someone to join...
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                            {players.map((p, i) => (
                                <div key={i} className="bg-white text-slate-900 p-4 rounded-xl shadow-lg font-bold text-lg text-center transform transition hover:-translate-y-1 hover:shadow-2xl flex items-center justify-center min-h-[80px] border-b-4 border-gray-200">
                                    {p.name}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer Action */}
                <div className="mt-8 sticky bottom-6">
                    <button
                        onClick={handleStartGame}
                        disabled={players.length === 0}
                        className={`w-full py-5 text-3xl font-black rounded-2xl shadow-2xl transition-all ${players.length > 0
                                ? 'bg-green-500 hover:bg-green-400 text-white transform hover:scale-[1.01] active:scale-[0.99]'
                                : 'bg-slate-700 text-slate-500 cursor-not-allowed'
                            }`}
                    >
                        {players.length === 0 ? "Waiting for Players..." : "START GAME 🚀"}
                    </button>
                </div>
            </div>
        );
    }

    if (view === 'HOST_GAME') {
        return (
            <HostGameView
                status={gameStatus}
                question={hostQuestion}
                stats={liveStats}
                leaderboard={leaderboard}
                onNext={handleNextQuestion}
                onShowLeaderboard={handleShowLeaderboard}
            />
        );
    }

    if (view === 'PLAYER_GAME') {
        return (
            <PlayerGameView
                state={playerGameState}
                question={playerQuestion}
                timer={timer}
                onSubmit={handleSubmitAnswer}
                result={playerResult}
                myAnswer={myAnswer}
                playerName={playerName}
            />
        );
    }

    return <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">Loading...</div>;
}

// --- SUB COMPONENTS ---

function HostGameView({ status, question, stats, leaderboard, onNext, onShowLeaderboard }) {
    if (status === 'QUESTION') {
        return (
            <div className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4">
                <div className="w-full max-w-6xl">
                    <div className="flex justify-between text-3xl font-black text-gray-400 mb-6">
                        <span>{question.questionIndex} / {question.totalQuestions}</span>
                        <div className="flex items-center gap-2 text-purple-600">
                            <span>⏱</span> {question.timeLimit}
                        </div>
                    </div>

                    <div className="bg-white rounded-[2rem] shadow-2xl p-16 text-center mb-10 min-h-[300px] flex items-center justify-center border-b-8 border-gray-200">
                        <h2 className="text-5xl font-black text-slate-800 leading-tight">{question.question}</h2>
                    </div>

                    <div className="grid grid-cols-2 gap-6 mb-10">
                        {question.options.map((opt, idx) => (
                            <div key={idx} className={`${Colors[idx]} p-8 rounded-2xl flex items-center shadow-xl transform transition hover:scale-[1.02]`}>
                                <div className="bg-black bg-opacity-20 w-16 h-16 rounded-full flex items-center justify-center text-white mr-6 font-bold text-2xl flex-shrink-0">
                                    {idx === 0 ? '▲' : idx === 1 ? '●' : idx === 2 ? '■' : '★'}
                                </div>
                                <span className="text-white text-3xl font-bold">{opt}</span>
                            </div>
                        ))}
                    </div>

                    <div className="flex justify-between items-center bg-slate-800 p-6 rounded-2xl text-white">
                        <div className="text-2xl font-bold text-slate-400">Answers Received</div>
                        <div className="flex items-center gap-4">
                            <span className="text-5xl font-black">{stats.answersReceived}</span>
                            <span className="text-2xl text-slate-500 font-bold">/ {stats.totalPlayers}</span>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (status === 'RESULT') {
        return (
            <div className="min-h-screen bg-indigo-900 flex flex-col items-center justify-center text-white p-4">
                <h1 className="text-6xl font-black mb-12">Time's Up! 🛑</h1>
                <button onClick={onShowLeaderboard} className="bg-white text-indigo-900 px-12 py-6 rounded-2xl text-3xl font-black shadow-2xl hover:bg-gray-100 transform transition hover:scale-105">
                    Show Leaderboard 🏆
                </button>
            </div>
        );
    }

    if (status === 'LEADERBOARD' || status === 'OVER') {
        return (
            <div className="min-h-screen bg-purple-900 flex flex-col items-center p-8 text-white">
                <h1 className="text-5xl font-black mb-12 tracking-wide uppercase">{status === 'OVER' ? '🎉 FINAL SCORES' : '🏆 Top Players'}</h1>
                <div className="w-full max-w-3xl space-y-4">
                    {leaderboard.map((player, idx) => (
                        <div key={idx} className="bg-white text-purple-900 p-6 rounded-2xl flex justify-between items-center shadow-xl transform transition hover:scale-[1.02]">
                            <div className="flex items-center gap-6">
                                <span className={`w-14 h-14 rounded-xl flex items-center justify-center font-black text-2xl ${idx === 0 ? 'bg-yellow-400 text-white' : idx === 1 ? 'bg-gray-300 text-gray-700' : idx === 2 ? 'bg-orange-400 text-white' : 'bg-purple-100 text-purple-400'}`}>
                                    {idx + 1}
                                </span>
                                <span className="font-bold text-3xl tracking-tight">{player.name}</span>
                            </div>
                            <span className="font-black text-4xl">{player.score}</span>
                        </div>
                    ))}
                </div>
                <div className="mt-16">
                    {status !== 'OVER' ? (
                        <button onClick={onNext} className="bg-green-500 hover:bg-green-400 px-10 py-5 rounded-xl text-2xl font-black shadow-lg">Next Question ➡️</button>
                    ) : (
                        <button onClick={() => window.location.reload()} className="bg-white hover:bg-gray-100 text-purple-900 px-10 py-5 rounded-xl text-2xl font-black shadow-lg">Start New Game 🔄</button>
                    )}
                </div>
            </div>
        );
    }
    return <div>Loading...</div>;
}

function PlayerGameView({ state, question, timer, onSubmit, result, myAnswer, playerName }) {
    if (state === 'WAITING') {
        return (
            <div className="min-h-screen bg-slate-800 flex flex-col items-center justify-center text-white p-6 text-center">
                <div className="animate-bounce text-7xl mb-6">🤩</div>
                <h2 className="text-4xl font-black mb-4">You're in, {playerName}!</h2>
                <p className="text-xl text-slate-400">Watch the big screen...</p>
            </div>
        );
    }

    if (state === 'ANSWERING') {
        return (
            <div className="min-h-screen bg-gray-100 flex flex-col">
                <div className="bg-white p-4 shadow-md flex justify-between items-center border-b-4 border-gray-200">
                    <span className="font-bold text-gray-500">Q{question.questionIndex}</span>
                    <div className="bg-purple-600 text-white px-4 py-2 rounded-full font-bold min-w-[80px] text-center">
                        {timer}s
                    </div>
                </div>
                <div className="flex-1 grid grid-cols-2 gap-4 p-4">
                    {Array.from({ length: question.optionsCount }).map((_, idx) => (
                        <button
                            key={idx}
                            onClick={() => onSubmit(idx)}
                            className={`${Colors[idx]} rounded-2xl shadow-lg flex items-center justify-center active:scale-95 transition-all active:ring-4 active:ring-white`}
                        >
                            <div className="text-white text-7xl drop-shadow-md">
                                {idx === 0 ? '▲' : idx === 1 ? '●' : idx === 2 ? '■' : '★'}
                            </div>
                        </button>
                    ))}
                </div>
            </div>
        );
    }

    if (state === 'SUBMITTED') {
        return (
            <div className="min-h-screen bg-indigo-600 flex flex-col items-center justify-center text-white p-6 text-center">
                <div className="animate-pulse text-8xl mb-6">🚀</div>
                <h2 className="text-4xl font-black">Answer Locked!</h2>
                <p className="text-indigo-200 mt-4 text-xl">Good luck!</p>
            </div>
        );
    }

    if (state === 'RESULT') {
        const isCorrect = result.correctAnswer === myAnswer;
        return (
            <div className={`min-h-screen flex flex-col items-center justify-center text-white p-6 text-center ${isCorrect ? 'bg-green-500' : 'bg-red-500'}`}>
                <div className="text-9xl mb-8 filter drop-shadow-lg">{isCorrect ? '😎' : '😵'}</div>
                <h2 className="text-6xl font-black mb-4">{isCorrect ? 'NAILED IT!' : 'NOPE!'}</h2>
                <p className="text-2xl font-bold opacity-80">{isCorrect ? "+ Points earned" : "Better luck next time"}</p>
            </div>
        );
    }
    return <div>Loading...</div>;
}