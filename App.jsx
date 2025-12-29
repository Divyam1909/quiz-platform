import React, { useState, useEffect } from 'react';
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
const Colors = ['bg-red-500', 'bg-blue-500', 'bg-yellow-500', 'bg-green-500'];

export default function App() {
    const [socket, setSocket] = useState(null);
    const [view, setView] = useState('LANDING');
    const [role, setRole] = useState(null);
    const [connectionError, setConnectionError] = useState(false);
    const [isLoading, setIsLoading] = useState(false); // Loading state

    // Shared State
    const [roomCode, setRoomCode] = useState('');
    const [playerName, setPlayerName] = useState('');
    const [myId, setMyId] = useState(null);

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

    // Helper: Vibrate on mobile
    const vibrate = (pattern = [50]) => {
        if (navigator.vibrate) {
            navigator.vibrate(pattern);
        }
    };

    // --- INITIALIZATION ---
    useEffect(() => {
        let storedId = localStorage.getItem('quiz_player_id');
        if (!storedId) {
            storedId = generateId();
            localStorage.setItem('quiz_player_id', storedId);
        }
        setMyId(storedId);

        const params = new URLSearchParams(window.location.search);
        const urlPin = params.get('pin');
        if (urlPin) setRoomCode(urlPin);

        const newSocket = io(BACKEND_URL);
        setSocket(newSocket);

        newSocket.on('connect', () => {
            setConnectionError(false);
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

        socket.on('session_restored', (data) => {
            console.log('Session Restored:', data);
            setRole(data.role);
            setRoomCode(data.roomCode);
            setGameStatus(data.gameState);
            setLeaderboard(data.leaderboard); // IMPORTANT for final screen

            if (data.role === 'HOST') {
                setView(data.gameState === 'LOBBY' ? 'HOST_LOBBY' : 'HOST_GAME');
                setPlayers(data.players || []);
                if (data.gameState === 'QUESTION') {
                    setHostQuestion({
                        question: data.question.title /* fix from server? sent text */ || data.question.text,
                        timeLimit: data.question.timeLimit,
                        questionIndex: 1,
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
                    setTimer(data.currentQuestion.timeLimit);
                } else if (data.gameState === 'LOBBY') {
                    setPlayerGameState('WAITING');
                } else if (data.gameState === 'OVER') {
                    setPlayerGameState('OVER');
                }
            }
        });

        socket.on('session_invalid', () => {
            sessionStorage.removeItem('quiz_session');
            setView('LANDING');
        });

        // --- GLOBAL EVENTS ---
        socket.on('game_reset', () => {
            setGameStatus('LOBBY');
            setLeaderboard([]);
            setPlayers([]); // Wait for join events or keep them? Server keeps them.
            // Actually, server keeps them, so we shouldn't wipe local players if we are host, 
            // but `player_joined` usually updates it. 
            // Let's rely on server state.
            // For Player:
            setPlayerGameState('WAITING');
            setPlayerQuestion(null);
            setPlayerResult(null);
            setMyAnswer(null);
            // For Host:
            setView('HOST_LOBBY');
        });

        socket.on('room_closed', () => {
            alert("The host has ended the session.");
            sessionStorage.removeItem('quiz_session');
            window.location.href = '/';
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
        socket.on('game_over', (data) => {
            // Handle both array (old format) and object (new format)
            if (Array.isArray(data)) {
                // Legacy format
                setLeaderboard(data);
                setGameStatus('OVER');
            } else {
                // New personalized format
                setLeaderboard(data.leaderboard);
                setGameStatus('OVER');

                // Store player's personal rank if provided
                if (data.playerRank) {
                    sessionStorage.setItem('playerRank', data.playerRank);
                    sessionStorage.setItem('playerScore', data.playerScore);
                    sessionStorage.setItem('totalPlayers', data.totalPlayers);
                }
            }
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

    useEffect(() => {
        if (timer > 0 && playerGameState === 'ANSWERING') {
            const interval = setInterval(() => {
                setTimer(t => {
                    if (t === 5) vibrate([200]); // Warning vibration at 5 seconds
                    return t - 1;
                });
            }, 1000);
            return () => clearInterval(interval);
        }
    }, [timer, playerGameState]);


    // --- ACTIONS ---

    const handleCreateQuiz = () => {
        const password = prompt("Enter admin password to host a quiz:");
        if (password !== 'admin') {
            alert("Incorrect password. Only admins can host quizzes.");
            return;
        }

        setIsLoading(true);
        vibrate([30]);
        socket.emit('create_room', quizData, (response) => {
            setRoomCode(response.roomCode);
            setRole('HOST');
            setView('HOST_LOBBY');
            setPlayers([]);
            setSession({ role: 'HOST', roomCode: response.roomCode, hostToken: response.hostToken });
            setIsLoading(false);
        });
    };

    const handleStartGame = () => {
        if (socket) {
            vibrate([50, 50, 50]);
            socket.emit('start_game', roomCode);
        }
    };
    const handleNextQuestion = () => socket.emit('next_question', roomCode);
    const handleShowLeaderboard = () => socket.emit('show_leaderboard', roomCode);

    const handleResetGame = () => {
        socket.emit('reset_game', roomCode);
    };

    const handleCloseRoom = () => {
        if (confirm("Are you sure you want to close the room for everyone?")) {
            socket.emit('close_room', roomCode);
        }
    };

    const handleJoinRoom = () => {
        if (!roomCode || !playerName) return alert("Please enter code and name");
        setIsLoading(true);
        vibrate([30]);
        socket.emit('join_room', { roomCode: roomCode.toUpperCase(), playerName, playerId: myId }, (response) => {
            if (response.error) {
                alert(response.error);
                vibrate([100, 50, 100]);
            } else {
                setRole('PLAYER');
                setView('PLAYER_GAME');
                setSession({ role: 'PLAYER', roomCode: roomCode.toUpperCase() });
                vibrate([50]);
            }
            setIsLoading(false);
        });
    };

    const handleSubmitAnswer = (index) => {
        if (playerGameState !== 'ANSWERING') return;
        if (myAnswer !== null) return; // Prevent re-answering
        vibrate([100]); // Strong vibration on answer
        setMyAnswer(index);
        socket.emit('submit_answer', { roomCode, answerIndex: index, timeRemaining: timer, playerId: myId });
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
                        <button onClick={handleJoinRoom} disabled={isLoading} className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed text-white font-black py-4 rounded-xl shadow-lg transform transition active:scale-95 text-xl flex items-center justify-center gap-2">
                            {isLoading && <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>}
                            {isLoading ? 'JOINING...' : 'JOIN GAME'}
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
                    <div className="mt-4 text-center">
                        <button onClick={handleCloseRoom} className="text-red-500 font-bold text-sm underline hover:text-red-400">Close Room</button>
                    </div>
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
                onReset={handleResetGame}
                onClose={handleCloseRoom}
            />
        );
    }

    if (view === 'PLAYER_GAME') {
        return (
            <PlayerGameView
                state={gameStatus === 'OVER' ? 'OVER' : playerGameState}
                question={playerQuestion}
                timer={timer}
                onSubmit={handleSubmitAnswer}
                result={playerResult}
                myAnswer={myAnswer}
                playerName={playerName}
                leaderboard={leaderboard} // Pass leaderboard
            />
        );
    }

    return <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">Loading...</div>;
}

// --- SUB COMPONENTS ---

function HostGameView({ status, question, stats, leaderboard, onNext, onShowLeaderboard, onReset, onClose }) {
    if (status === 'QUESTION') {
        return (
            <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
                <div className="w-full max-w-6xl h-screen flex flex-col justify-center py-6">
                    {/* Header - Question Counter & Timer */}
                    <div className="flex justify-between items-center text-2xl font-black text-gray-400 mb-4">
                        <span>Q {question.questionIndex} / {question.totalQuestions}</span>
                        <div className="flex items-center gap-2 text-purple-600 bg-purple-100 px-4 py-2 rounded-lg">
                            <span>⏱</span> {question.timeLimit}s
                        </div>
                    </div>

                    {/* Question Box - Compact */}
                    <div className="bg-white rounded-2xl shadow-2xl p-8 text-center mb-6 border-b-4 border-gray-200">
                        <h2 className="text-4xl font-black text-slate-800 leading-tight">{question.question}</h2>
                    </div>

                    {/* Options Grid - Compact */}
                    <div className="grid grid-cols-2 gap-4 mb-6">
                        {question.options.map((opt, idx) => (
                            <div key={idx} className={`${Colors[idx]} p-6 rounded-xl flex items-center shadow-lg`}>
                                <div className="bg-black bg-opacity-20 w-12 h-12 rounded-full flex items-center justify-center text-white mr-4 font-bold text-xl flex-shrink-0">
                                    {idx === 0 ? '▲' : idx === 1 ? '●' : idx === 2 ? '■' : '★'}
                                </div>
                                <span className="text-white text-2xl font-bold leading-tight">{opt}</span>
                            </div>
                        ))}
                    </div>

                    {/* Answers Stats - Now visible without scrolling */}
                    <div className="flex justify-between items-center bg-slate-800 p-5 rounded-xl text-white shadow-lg">
                        <div className="text-xl font-bold text-slate-300">Answers Received</div>
                        <div className="flex items-center gap-3">
                            <span className="text-4xl font-black text-green-400">{stats.answersReceived}</span>
                            <span className="text-xl text-slate-400 font-bold">/ {stats.totalPlayers}</span>
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
            <div className="min-h-screen bg-purple-900 flex flex-col items-center p-6 text-white">
                <h1 className="text-4xl font-black mb-8 mt-4 tracking-wide uppercase">{status === 'OVER' ? '🎉 FINAL SCORES' : '🏆 Top Players'}</h1>
                <div className="w-full max-w-4xl flex-1 overflow-y-auto mb-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pb-4">
                        {leaderboard.map((player, idx) => (
                            <div key={idx} className="bg-white text-purple-900 p-4 rounded-xl flex justify-between items-center shadow-lg">
                                <div className="flex items-center gap-4">
                                    <span className={`w-12 h-12 rounded-lg flex items-center justify-center font-black text-xl ${idx === 0 ? 'bg-yellow-400 text-white' : idx === 1 ? 'bg-gray-300 text-gray-700' : idx === 2 ? 'bg-orange-400 text-white' : 'bg-purple-100 text-purple-400'}`}>
                                        {idx + 1}
                                    </span>
                                    <span className="font-bold text-xl tracking-tight">{player.name}</span>
                                </div>
                                <span className="font-black text-2xl">{player.score}</span>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="flex gap-4 pb-4">
                    {status !== 'OVER' ? (
                        <button onClick={onNext} className="bg-green-500 hover:bg-green-400 px-10 py-4 rounded-xl text-xl font-black shadow-lg">Next Question ➡️</button>
                    ) : (
                        <>
                            <button onClick={onReset} className="bg-white hover:bg-gray-100 text-purple-900 px-8 py-4 rounded-xl text-xl font-black shadow-lg">Restart Game 🔄</button>
                            <button onClick={onClose} className="bg-red-500 hover:bg-red-400 text-white px-8 py-4 rounded-xl text-xl font-black shadow-lg">End Session ❌</button>
                        </>
                    )}
                </div>
            </div>
        );
    }
    return <div>Loading...</div>;
}

function PlayerGameView({ state, question, timer, onSubmit, result, myAnswer, playerName, leaderboard }) {
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
                <div className="bg-white p-4 shadow-md border-b-4 border-gray-200">
                    <div className="flex justify-between items-center mb-2">
                        <span className="font-bold text-gray-500">Q{question.questionIndex}</span>
                        <div className={`px-4 py-1 rounded-full font-bold transition-all ${timer <= 5 ? 'bg-red-600 animate-pulse' : 'bg-purple-600'} text-white`}>
                            {timer}s
                        </div>
                    </div>
                    {/* QUESTION TEXT FOR MOBILE */}
                    <h3 className="text-xl font-bold text-gray-800 leading-tight">{question.questionText}</h3>
                </div>

                <div className="flex-1 p-4 grid gap-4 overflow-y-auto">
                    {question.options.map((opt, idx) => (
                        <button
                            key={idx}
                            onClick={() => onSubmit(idx)}
                            className={`${Colors[idx]} rounded-2xl shadow-lg p-6 flex items-center active:scale-95 transition-all text-left group`}
                        >
                            <div className="bg-black bg-opacity-20 w-12 h-12 rounded-full flex items-center justify-center text-white mr-4 font-bold text-xl flex-shrink-0 group-active:scale-110 transition-transform">
                                {idx === 0 ? '▲' : idx === 1 ? '●' : idx === 2 ? '■' : '★'}
                            </div>
                            <span className="text-white text-lg font-bold leading-tight">{opt}</span>
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

    if (state === 'OVER') {
        const myRank = parseInt(sessionStorage.getItem('playerRank')) || null;
        const myScore = parseInt(sessionStorage.getItem('playerScore')) || 0;
        const totalPlayers = parseInt(sessionStorage.getItem('totalPlayers')) || 0;

        return (
            <div className="min-h-screen bg-purple-900 flex flex-col items-center p-6 text-white">
                {myRank && (
                    <div className="w-full max-w-md mb-6 mt-4">
                        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 p-6 rounded-2xl shadow-2xl border-4 border-yellow-400">
                            <div className="text-center mb-2">
                                <span className="text-yellow-300 text-sm font-bold uppercase tracking-widest">Your Rank</span>
                            </div>
                            <div className="flex justify-between items-center">
                                <div className="text-center flex-1">
                                    <div className="text-6xl font-black text-white">#{myRank}</div>
                                    <div className="text-purple-200 text-sm">of {totalPlayers}</div>
                                </div>
                                <div className="h-16 w-px bg-purple-400"></div>
                                <div className="text-center flex-1">
                                    <div className="text-4xl font-black text-yellow-300">{myScore}</div>
                                    <div className="text-purple-200 text-sm">Points</div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                <h1 className="text-3xl font-black mb-6 uppercase">🏆 Top Players</h1>
                <div className="w-full max-w-md space-y-3">
                    {leaderboard && leaderboard.map((player, idx) => (
                        <div key={idx} className="bg-white text-purple-900 p-4 rounded-xl flex justify-between items-center shadow-lg">
                            <div className="flex items-center gap-4">
                                <span className={`w-10 h-10 rounded-lg flex items-center justify-center font-black text-xl ${idx === 0 ? 'bg-yellow-400 text-white' : idx === 1 ? 'bg-gray-300 text-gray-700' : idx === 2 ? 'bg-orange-400 text-white' : 'bg-purple-100 text-purple-400'}`}>
                                    {idx + 1}
                                </span>
                                <span className="font-bold text-xl">{player.name}</span>
                            </div>
                            <span className="font-black text-2xl">{player.score}</span>
                        </div>
                    ))}
                </div>
                <div className="mt-8 text-center text-purple-200">
                    Host will restart soon...
                </div>
            </div>
        );
    }

    return <div>Loading...</div>;
}