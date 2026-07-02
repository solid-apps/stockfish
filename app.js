import { Chessground } from './vendor/chessground.min.js';
import { Chess } from './vendor/chess.js';

// --- Engine (UCI over web worker) -----------------------------------------

class Engine {
  constructor(url) {
    this.worker = new Worker(url);
    this.listeners = [];
    this.queue = Promise.resolve(); // serializes searches (game moves vs hints)
    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      this.listeners = this.listeners.filter((fn) => !fn(line));
    };
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  // Resolves when a line matching `re` arrives; listener returns true to detach.
  wait(re) {
    return new Promise((resolve) => {
      this.listeners.push((line) => {
        const m = line.match(re);
        if (m) resolve(m);
        return !!m;
      });
    });
  }

  // Observe every line until the returned detach function is called.
  listen(fn) {
    let active = true;
    this.listeners.push((line) => {
      if (!active) return true; // lazily removed
      fn(line);
      return false;
    });
    return () => { active = false; };
  }

  async init() {
    const ready = this.wait(/^uciok$/);
    this.send('uci');
    await ready;
    this.send('setoption name UCI_LimitStrength value true');
  }

  setElo(elo) {
    this.send(`setoption name UCI_Elo value ${elo}`);
  }

  newGame() {
    this.send('stop');
    this.send('ucinewgame');
  }

  // full=true searches at full strength (hints, evals).
  // Returns {move, score} — score is {kind: 'cp'|'mate', val} from the
  // side-to-move's point of view, from the deepest info line seen.
  search(fen, movetimeMs, { full = false } = {}) {
    const run = async () => {
      this.send(`setoption name UCI_LimitStrength value ${full ? 'false' : 'true'}`);
      let score = null;
      const detach = this.listen((line) => {
        const m = line.match(/^info .*\bscore (cp|mate) (-?\d+)/);
        if (m) score = { kind: m[1], val: Number(m[2]) };
      });
      const done = this.wait(/^bestmove (\S+)/);
      this.send(`position fen ${fen}`);
      this.send(`go movetime ${movetimeMs}`);
      const move = (await done)[1];
      detach();
      return { move, score };
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }
}

// --- Game state -------------------------------------------------------------

const chess = new Chess();
const engine = new Engine('vendor/stockfish-18-lite-single.js');

let playerColor = 'white';
let thinking = false;
let searchId = 0; // bumped on new game to discard stale engine replies
let trainer = null; // active training position {fen, name, goal, playerSide}, or null
let positions = []; // loaded from positions.json

const statusEl = document.getElementById('status');
const movesEl = document.getElementById('moves');
const eloInput = document.getElementById('elo');
const eloLabel = document.getElementById('elo-label');
const colorSelect = document.getElementById('color-select');
const undoBtn = document.getElementById('undo');
const hintBtn = document.getElementById('hint');
const promoOverlay = document.getElementById('promo-overlay');
const trainerSelect = document.getElementById('trainer-select');
const evalFill = document.getElementById('eval-white');
const evalNum = document.getElementById('eval-num');

// --- Eval bar -----------------------------------------------------------------

// score: {kind, val} from `stm`'s ('w'|'b') point of view
function setEval(score, stm) {
  if (!score) return;
  const sign = stm === 'w' ? 1 : -1;
  let frac, label;
  if (score.kind === 'mate') {
    const mate = sign * score.val;
    frac = mate > 0 ? 1 : 0;
    label = `#${Math.abs(score.val)}`;
  } else {
    const cp = sign * score.val;
    // cp -> win probability, same shape lichess uses
    frac = 1 / (1 + Math.exp(-0.00368208 * cp));
    label = (cp >= 0 ? '+' : '−') + Math.abs(cp / 100).toFixed(1);
  }
  evalFill.style.height = `${(frac * 100).toFixed(1)}%`;
  evalNum.textContent = label;
}

function setEvalTerminal() {
  if (chess.isCheckmate()) {
    const whiteWon = chess.turn() === 'b';
    evalFill.style.height = whiteWon ? '100%' : '0%';
    evalNum.textContent = whiteWon ? '1-0' : '0-1';
  } else {
    evalFill.style.height = '50%';
    evalNum.textContent = '½';
  }
}

// quick full-strength eval of the current position (start of games/puzzles)
async function evalCurrent() {
  const fenAtRequest = chess.fen();
  const { score } = await engine.search(fenAtRequest, 300, { full: true });
  if (chess.fen() === fenAtRequest && !chess.isGameOver()) {
    setEval(score, fenAtRequest.split(' ')[1]);
  }
}

// --- Sounds (lichess standard set) -------------------------------------------

const sounds = {
  move: new Audio('sounds/Move.mp3'),
  capture: new Audio('sounds/Capture.mp3'),
  gameEnd: new Audio('sounds/GenericNotify.mp3'),
};
let muted = localStorage.getItem('muted') === '1';

function playSound(name) {
  if (muted) return;
  const a = sounds[name];
  a.currentTime = 0;
  a.play().catch(() => {}); // autoplay may be blocked before first gesture
}

function soundForMove(move) {
  playSound(move.captured ? 'capture' : 'move');
  if (chess.isGameOver()) playSound('gameEnd');
}

const ground = Chessground(document.getElementById('board'), {
  fen: chess.fen(),
  orientation: playerColor,
  movable: {
    color: playerColor,
    free: false,
    dests: toDests(),
    showDests: true,
    events: { after: onUserMove },
  },
  premovable: { enabled: true },
});

// --- Helpers ----------------------------------------------------------------

function fullColor(c) {
  return c === 'w' ? 'white' : 'black';
}

function toDests() {
  const dests = new Map();
  for (const m of chess.moves({ verbose: true })) {
    const arr = dests.get(m.from) || [];
    arr.push(m.to);
    dests.set(m.from, arr);
  }
  return dests;
}

function sync(lastMove) {
  ground.set({
    fen: chess.fen(),
    turnColor: fullColor(chess.turn()),
    check: chess.inCheck(),
    ...(lastMove ? { lastMove } : {}),
    movable: {
      color: !thinking && !chess.isGameOver() ? playerColor : undefined,
      dests: toDests(),
    },
  });
  renderMoves();
  renderStatus();
  if (chess.isGameOver()) setEvalTerminal();
  undoBtn.disabled = thinking || chess.isGameOver() || chess.history().length < minHistoryForUndo;
}

function renderMoves() {
  const history = chess.history();
  movesEl.innerHTML = '';
  for (let i = 0; i < history.length; i += 2) {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = `${i / 2 + 1}.`;
    li.appendChild(num);
    for (const san of [history[i], history[i + 1]]) {
      if (!san) continue;
      const s = document.createElement('span');
      s.className = 'san';
      s.textContent = san;
      li.appendChild(s);
    }
    movesEl.appendChild(li);
  }
  movesEl.scrollTop = movesEl.scrollHeight;
}

function trainerGoalText() {
  const side = playerColor === 'white' ? 'White' : 'Black';
  return trainer.goal === 'win' ? `convert the win as ${side}` : `hold the draw as ${side}`;
}

function renderStatus() {
  if (trainer && chess.isGameOver()) {
    const playerWon = chess.isCheckmate() && fullColor(chess.turn()) !== playerColor;
    const drawn = !chess.isCheckmate();
    const success = trainer.goal === 'win' ? playerWon : playerWon || drawn;
    statusEl.textContent = success
      ? `Success — you ${trainer.goal === 'win' ? 'converted the win' : 'held the draw'}!`
      : `Failed — the goal was to ${trainerGoalText()}. "New game" retries it.`;
    return;
  }
  if (chess.isCheckmate()) {
    const winner = fullColor(chess.turn()) === playerColor ? 'Stockfish wins' : 'You win';
    statusEl.textContent = `Checkmate — ${winner}!`;
  } else if (chess.isStalemate()) {
    statusEl.textContent = 'Draw — stalemate.';
  } else if (chess.isThreefoldRepetition()) {
    statusEl.textContent = 'Draw — threefold repetition.';
  } else if (chess.isInsufficientMaterial()) {
    statusEl.textContent = 'Draw — insufficient material.';
  } else if (chess.isDraw()) {
    statusEl.textContent = 'Draw.';
  } else if (thinking) {
    statusEl.textContent = 'Stockfish is thinking…';
  } else {
    const move = chess.inCheck() ? 'Your move — check!' : 'Your move.';
    statusEl.textContent = trainer ? `Goal: ${trainerGoalText()}. ${move}` : move;
  }
}

// --- Moves ------------------------------------------------------------------

function onUserMove(orig, dest) {
  const piece = chess.get(orig);
  const lastRank = piece && piece.color === 'w' ? '8' : '1';
  if (piece && piece.type === 'p' && dest[1] === lastRank) {
    askPromotion().then((promotion) => {
      if (promotion) applyUserMove(orig, dest, promotion);
      else sync(); // cancelled: snap the board back
    });
    return;
  }
  applyUserMove(orig, dest);
}

async function hint() {
  if (thinking || chess.isGameOver()) return;
  hintBtn.disabled = true;
  hintBtn.textContent = 'Thinking…';
  const fenAtRequest = chess.fen();
  const { move: uci, score } = await engine.search(fenAtRequest, 600, { full: true });
  hintBtn.disabled = false;
  hintBtn.textContent = 'Get a hint';
  if (chess.fen() !== fenAtRequest) return; // position changed meanwhile
  setEval(score, fenAtRequest.split(' ')[1]);
  ground.setAutoShapes([{ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush: 'green' }]);
}

function applyUserMove(orig, dest, promotion) {
  let move;
  try {
    move = chess.move({ from: orig, to: dest, promotion });
  } catch {
    sync(); // illegal (e.g. bad premove): snap back
    return;
  }
  ground.setAutoShapes([]);
  soundForMove(move);
  sync([orig, dest]);
  if (!chess.isGameOver()) engineMove();
}

async function engineMove() {
  thinking = true;
  sync();
  const id = searchId;
  const fenAtSearch = chess.fen();
  // trainer positions are defended at full strength — that's the exercise
  const { move: uci, score } = await engine.search(fenAtSearch, 800, { full: !!trainer });
  if (id !== searchId) return; // a new game started meanwhile
  thinking = false;
  setEval(score, fenAtSearch.split(' ')[1]);
  const move = chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  });
  soundForMove(move);
  sync([move.from, move.to]);
  ground.playPremove();
}

function askPromotion() {
  promoOverlay.classList.remove('hidden');
  return new Promise((resolve) => {
    const done = (value) => {
      promoOverlay.classList.add('hidden');
      promoOverlay.onclick = null;
      resolve(value);
    };
    promoOverlay.onclick = (e) => {
      const btn = e.target.closest('button[data-piece]');
      done(btn ? btn.dataset.piece : null);
    };
  });
}

// --- Controls ---------------------------------------------------------------

let minHistoryForUndo = 2; // +1 when the engine moved first in this game

function startFreePlay() {
  trainer = null;
  trainerSelect.value = '';
  chess.reset();
  const choice = colorSelect.value;
  playerColor = choice === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : choice;
  begin();
}

function startTrainer(p) {
  trainer = p;
  chess.load(p.fen);
  playerColor = fullColor(p.playerSide);
  begin();
}

function begin() {
  searchId++;
  thinking = false;
  engine.newGame();
  engine.setElo(Number(eloInput.value));
  ground.set({ orientation: playerColor, lastMove: undefined });
  ground.cancelPremove();
  ground.setAutoShapes([]);
  const engineFirst = fullColor(chess.turn()) !== playerColor;
  minHistoryForUndo = (engineFirst ? 1 : 0) + 2;
  sync();
  if (engineFirst) engineMove();
  else evalCurrent();
}

// in trainer mode "New game" retries the current position
function newGame() {
  if (trainer) startTrainer(trainer);
  else startFreePlay();
}

async function loadPositions() {
  try {
    positions = await (await fetch('positions.json')).json();
  } catch {
    return; // trainer unavailable; free play still works
  }
  const groups = new Map();
  positions.forEach((p, i) => {
    let g = groups.get(p.category);
    if (!g) {
      g = document.createElement('optgroup');
      g.label = p.category;
      trainerSelect.appendChild(g);
      groups.set(p.category, g);
    }
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${p.name} (${p.goal})`;
    g.appendChild(o);
  });
}

trainerSelect.addEventListener('change', () => {
  if (trainerSelect.value === '') startFreePlay();
  else startTrainer(positions[Number(trainerSelect.value)]);
});

function undo() {
  if (thinking || chess.turn() !== playerColor[0]) return;
  chess.undo(); // engine's reply
  chess.undo(); // player's move
  const last = chess.history({ verbose: true }).at(-1);
  sync(last ? [last.from, last.to] : undefined);
  evalCurrent();
}

const muteBtn = document.getElementById('mute');
muteBtn.textContent = muted ? '🔇' : '🔊';
muteBtn.addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('muted', muted ? '1' : '0');
  muteBtn.textContent = muted ? '🔇' : '🔊';
});

document.getElementById('new-game').addEventListener('click', newGame);
document.getElementById('flip').addEventListener('click', () => ground.toggleOrientation());
undoBtn.addEventListener('click', undo);
hintBtn.addEventListener('click', hint);
eloInput.addEventListener('input', () => {
  eloLabel.textContent = eloInput.value;
  engine.setElo(Number(eloInput.value));
});

// --- Boot -------------------------------------------------------------------

statusEl.textContent = 'Loading engine…';
loadPositions(); // in parallel with engine init
await engine.init();
newGame();

// Console/debug handle
window.game = { chess, engine, move: applyUserMove, newGame, sounds, hint, startTrainer };
