let sdkReady = false;
let sdk = null;
let selectedTokenId = null;
let waypoints = [];
let patrolTimeout = null;
let currentWaypointIndex = 0;
let direction = 1;
let mode = 'loop';
let speed = 10; // дюймов в секунду

// DOM элементы
const addWaypointBtn = document.getElementById('addWaypointBtn');
const clearWaypointsBtn = document.getElementById('clearWaypointsBtn');
const startPatrolBtn = document.getElementById('startPatrolBtn');
const stopPatrolBtn = document.getElementById('stopPatrolBtn');
const patrolModeSelect = document.getElementById('patrolMode');
const waypointListUl = document.getElementById('waypointList');
const statusDiv = document.getElementById('status');
const speedSlider = document.getElementById('speedSlider');
const speedValue = document.getElementById('speedValue');

async function initSDK() {
    if (typeof OBR === 'undefined') {
        statusDiv.innerText = 'Ошибка: расширение запущено вне Owlbear Rodeo';
        return;
    }
    sdk = OBR;
    sdkReady = true;
    
    // Настройка слушателей UI
    addWaypointBtn.onclick = startAddingWaypoint;
    clearWaypointsBtn.onclick = clearWaypoints;
    startPatrolBtn.onclick = startPatrol;
    stopPatrolBtn.onclick = stopPatrol;
    patrolModeSelect.onchange = (e) => { mode = e.target.value; };
    speedSlider.oninput = (e) => { 
        speed = parseInt(e.target.value);
        speedValue.innerText = speed;
    };
    
    // Подписка на изменение выделения токенов
    sdk.selection.onChange(async (selection) => {
        if (selection && selection.length === 1) {
            const tokenId = selection[0];
            const items = await sdk.room.getItems();
            const token = items.find(item => item.id === tokenId && item.type === 'token');
            if (token) {
                selectedTokenId = tokenId;
                enableControls(true);
                statusDiv.innerText = `Выбран: ${token.text || tokenId.slice(0,6)}`;
                await loadWaypointsForToken(tokenId);
                return;
            }
        }
        selectedTokenId = null;
        enableControls(false);
        statusDiv.innerText = 'Выделите NPC, чтобы начать';
        waypoints = [];
        renderWaypointList();
        stopPatrol();
    });
}

function enableControls(enabled) {
    addWaypointBtn.disabled = !enabled;
    clearWaypointsBtn.disabled = !enabled;
    patrolModeSelect.disabled = !enabled;
    speedSlider.disabled = !enabled;
    startPatrolBtn.disabled = !(enabled && waypoints.length >= 2);
    stopPatrolBtn.disabled = !patrolTimeout;
}

function startAddingWaypoint() {
    if (!selectedTokenId) return;
    statusDiv.innerText = 'Кликните на карте, чтобы добавить точку маршрута';
    
    const unsubscribe = sdk.scene.onClick(async (event) => {
        const point = event.point;
        if (point) {
            waypoints.push({ x: point.x, y: point.y });
            renderWaypointList();
            statusDiv.innerText = `Точка ${waypoints.length} добавлена. Кликните снова или нажмите "Очистить"`;
            await saveWaypointsForToken(selectedTokenId);
        }
        unsubscribe();
        setTimeout(() => {
            if (selectedTokenId) statusDiv.innerText = `Выбран: ${selectedTokenId}`;
            else statusDiv.innerText = 'Выделите NPC';
        }, 1500);
    });
}

async function clearWaypoints() {
    waypoints = [];
    renderWaypointList();
    stopPatrol();
    if (selectedTokenId) await saveWaypointsForToken(selectedTokenId);
    statusDiv.innerText = 'Точки маршрута очищены';
    startPatrolBtn.disabled = true;
}

function renderWaypointList() {
    waypointListUl.innerHTML = '';
    waypoints.forEach((wp, idx) => {
        const li = document.createElement('li');
        li.textContent = `Точка ${idx+1}: (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)})`;
        const delBtn = document.createElement('button');
        delBtn.textContent = 'X';
        delBtn.style.marginLeft = '8px';
        delBtn.onclick = () => removeWaypoint(idx);
        li.appendChild(delBtn);
        waypointListUl.appendChild(li);
    });
    if (waypoints.length === 0) {
        const li = document.createElement('li');
        li.innerHTML = 'Нет точек. Нажмите "➕ Добавить точку" и кликните на карте.';
        waypointListUl.appendChild(li);
    }
}

function removeWaypoint(index) {
    waypoints.splice(index, 1);
    renderWaypointList();
    if (patrolTimeout) stopPatrol();
    if (selectedTokenId) saveWaypointsForToken(selectedTokenId);
    startPatrolBtn.disabled = !(selectedTokenId && waypoints.length >= 2);
}

function calculateDelay(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    let delay = (distance / speed) * 1000;
    return Math.min(10000, Math.max(100, delay));
}

async function moveTokenToWaypoint(index) {
    if (!selectedTokenId) return false;
    const wp = waypoints[index];
    try {
        const items = await sdk.room.getItems();
        const token = items.find(item => item.id === selectedTokenId);
        if (token && token.position) {
            await sdk.room.updateItems([{
                id: selectedTokenId,
                position: { x: wp.x, y: wp.y }
            }]);
            return true;
        }
    } catch (err) {
        console.error('Ошибка перемещения:', err);
        statusDiv.innerText = 'Ошибка! Патруль остановлен.';
        stopPatrol();
        return false;
    }
    return false;
}

async function patrolStep() {
    if (!selectedTokenId || waypoints.length < 2) {
        stopPatrol();
        return;
    }
    
    let nextIndex;
    if (mode === 'loop') {
        nextIndex = (currentWaypointIndex + 1) % waypoints.length;
    } else {
        nextIndex = currentWaypointIndex + direction;
        if (nextIndex >= waypoints.length) {
            nextIndex = waypoints.length - 2;
            direction = -1;
        } else if (nextIndex < 0) {
            nextIndex = 1;
            direction = 1;
        }
    }
    
    const currentPos = waypoints[currentWaypointIndex];
    const nextPos = waypoints[nextIndex];
    const delayMs = calculateDelay(currentPos, nextPos);
    
    const success = await moveTokenToWaypoint(nextIndex);
    if (!success) return;
    
    currentWaypointIndex = nextIndex;
    patrolTimeout = setTimeout(patrolStep, delayMs);
}

function startPatrol() {
    if (!selectedTokenId || waypoints.length < 2) {
        statusDiv.innerText = 'Нужно минимум 2 точки маршрута';
        return;
    }
    if (patrolTimeout) stopPatrol();
    
    currentWaypointIndex = 0;
    direction = 1;
    
    moveTokenToWaypoint(0).then(success => {
        if (!success) return;
        const firstDelay = 100;
        patrolTimeout = setTimeout(patrolStep, firstDelay);
        stopPatrolBtn.disabled = false;
        startPatrolBtn.disabled = true;
        statusDiv.innerText = '🚶 Патрулирование запущено...';
    });
}

function stopPatrol() {
    if (patrolTimeout) {
        clearTimeout(patrolTimeout);
        patrolTimeout = null;
    }
    stopPatrolBtn.disabled = true;
    startPatrolBtn.disabled = !(selectedTokenId && waypoints.length >= 2);
    if (selectedTokenId) statusDiv.innerText = '⏸️ Патруль остановлен';
    else statusDiv.innerText = 'Выделите NPC';
}

async function saveWaypointsForToken(tokenId) {
    if (!sdkReady) return;
    const patrolData = { waypoints, mode, speed };
    try {
        const items = await sdk.room.getItems();
        const token = items.find(item => item.id === tokenId);
        if (token) {
            await sdk.room.updateItems([{
                id: tokenId,
                metadata: { ...token.metadata, patrolData }
            }]);
        }
    } catch (e) { console.warn('Не удалось сохранить данные патруля', e); }
}

async function loadWaypointsForToken(tokenId) {
    if (!sdkReady) return;
    try {
        const items = await sdk.room.getItems();
        const token = items.find(item => item.id === tokenId);
        if (token?.metadata?.patrolData) {
            const data = token.metadata.patrolData;
            waypoints = data.waypoints || [];
            mode = data.mode || 'loop';
            speed = data.speed || 10;
            patrolModeSelect.value = mode;
            speedSlider.value = speed;
            speedValue.innerText = speed;
            renderWaypointList();
            statusDiv.innerText = 'Загружены сохранённые маршруты';
            startPatrolBtn.disabled = !(waypoints.length >= 2);
        } else {
            waypoints = [];
            renderWaypointList();
            startPatrolBtn.disabled = true;
        }
    } catch (e) { console.warn('Не удалось загрузить данные', e); }
}

initSDK();