import { generateAndDownloadBridge } from 'bridge-generator';

const room = new WebsimSocket();

const creatorPanel = document.getElementById('creator-panel');
const downloadBridgeBtn = document.getElementById('download-bridge-btn');
const bridgeStatusDisplay = document.getElementById('bridge-status-display');
const bridgeStatusIndicator = document.getElementById('bridge-status-indicator');
const bridgeStatusText = document.getElementById('bridge-status-text');
const statusPanel = document.getElementById('status-panel');
const statusMessage = document.getElementById('status-message');
const progressBar = document.getElementById('progress-bar');
const downloadLinkContainer = document.getElementById('download-link-container');
const downloadLink = document.getElementById('download-link');

const manualUrlInput = document.getElementById('manual-url');
const manualPlatformSelect = document.getElementById('manual-platform');
const manualBuildBtn = document.getElementById('manual-build-btn');

let creator = null;
let currentUser = null;
let isCreator = false;
let bridgeSocket = null;
let activeBuilds = {}; // Key: requestId, Value: { fromClientId }
let rebootTimer = null;
let warningTimer = null;

function updateBridgeStatusUI(status) {
    if (status === 'connected') {
        bridgeStatusIndicator.className = 'connected';
        bridgeStatusText.textContent = 'Online';
        disableAllBuildButtons(false);
    } else { // 'disconnected' or other states
        bridgeStatusIndicator.className = 'disconnected';
        bridgeStatusText.textContent = 'Offline';
        disableAllBuildButtons(true);
    }
}

function handleRoomStateChange(currentRoomState) {
    if (currentRoomState && currentRoomState.bridge) {
        bridgeStatusDisplay.classList.remove('hidden');
        updateBridgeStatusUI(currentRoomState.bridge.status);
    }
}

async function main() {
    try {
        await room.initialize();
        
        room.subscribeRoomState(handleRoomStateChange);
        
        [creator, currentUser] = await Promise.all([
            window.websim.getCreator(),
            window.websim.getUser()
        ]);

        if (creator && currentUser && creator.id === currentUser.id) {
            isCreator = true;
            setupCreatorView();
            startRebootTimer(); // Start the auto-reboot system for creators
        }
        
        setupEventListeners();

        // Initial check for non-creators
        if (!isCreator && room.roomState && room.roomState.bridge) {
            bridgeStatusDisplay.classList.remove('hidden');
            updateBridgeStatusUI(room.roomState.bridge.status);
        } else if (!isCreator) {
            // Hide build button if bridge state isn't known yet
            disableAllBuildButtons(true);
        }

    } catch (err) {
        console.error("Failed to initialize the application.", err);
    }
}

function startBuild(url, platform, appName) {
    if (!url) {
        alert("Please provide a valid URL.");
        return;
    }

    const arch = 'x64';
    const requestId = `${room.clientId}-${Date.now()}`;
    const finalAppName = appName || new URL(url).hostname;

    disableAllBuildButtons(true);
    statusPanel.classList.remove('hidden');
    progressBar.style.backgroundColor = 'var(--primary-color)';
    updateStatus('Requesting build from creator...', 10);
    downloadLinkContainer.classList.add('hidden');

    room.send({
        type: 'build_request',
        payload: { url, platform, arch, appName: finalAppName, requestId, fromClientId: room.clientId }
    });
}

function handleManualBuildClick() {
    let url = manualUrlInput.value;
    const platform = manualPlatformSelect.value;
    
    const websimUrlRegex = /^https:\/\/websim\.com\/@([^\/]+)\/([^\/]+)/;
    const match = url.match(websimUrlRegex);

    if (match) {
        const username = match[1];
        const label = match[2];
        url = `https://${label}--${username}.on.websim.com`;
        console.log(`Converted websim URL to: ${url}`);
    }

    try {
        // Validate URL
        new URL(url);
    } catch (_) {
        alert("Please enter a valid URL (e.g., https://example.com)");
        return;
    }

    const appName = new URL(url).hostname;
    startBuild(url, platform, appName);
}

function disableAllBuildButtons(disabled) {
    document.querySelectorAll('#manual-build-btn').forEach(btn => {
        btn.disabled = disabled;
    });
}

function updateStatus(message, progress) {
    statusMessage.textContent = message;
    progressBar.style.width = `${progress}%`;
}

function setupCreatorView() {
    creatorPanel.classList.remove('hidden');
    downloadBridgeBtn.addEventListener('click', () => {
        generateAndDownloadBridge();
    });
    connectToBridge();
}

function connectToBridge() {
    if (!isCreator) return;

    bridgeSocket = new WebSocket('ws://localhost:3001');

    bridgeSocket.onopen = () => {
        console.log('Connected to local bridge.');
        room.updateRoomState({ bridge: { status: 'connected' } });
    };

    bridgeSocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'build_complete') {
            // With the new bridge, the creator gets a direct download link
            // to their local file server. No upload is needed.
            console.log("Build complete, download from local server:", data);
            
            // The build is for another user, notify them.
            // This path is tricky as it assumes the user can reach the creator's machine.
            // For now, we are just implementing the creator-download path.
            const build = activeBuilds[data.requestId];
            if (build && build.fromClientId !== room.clientId) {
                 room.send({
                    type: 'build_failed',
                    targetClientId: build.fromClientId,
                    payload: { error: 'Direct download from creator is not yet supported for remote users.' }
                });
            } else { // It's a build for the creator themselves
                 room.send({
                    type: 'build_complete',
                    targetClientId: room.clientId,
                    payload: { 
                        url: `http://localhost:3002${data.downloadUrl}`,
                        appName: data.appName,
                        fileName: data.fileName
                    }
                });
            }

        } else if (data.type === 'build_error') {
            console.error('Build failed:', data.error);
            const build = activeBuilds[data.requestId];
            if (build) {
                room.send({
                    type: 'build_failed',
                    targetClientId: build.fromClientId,
                    payload: { error: data.error }
                });
                delete activeBuilds[data.requestId];
            }
        }
    };

    bridgeSocket.onclose = () => {
        console.log('Disconnected from local bridge. Retrying in 5s...');
        room.updateRoomState({ bridge: { status: 'disconnected' } });
        setTimeout(connectToBridge, 5000);
    };

    bridgeSocket.onerror = (err) => {
        console.error('Bridge WebSocket error:', err);
        bridgeSocket.close();
    };
}

async function uploadAndNotify(file, requestId) {
    // This function is no longer used with the new bridge model.
    // The bridge now serves the file directly.
    console.warn("uploadAndNotify is deprecated with the new bridge version.");
}

function startRebootTimer() {
    if (!isCreator) return;
    
    // Clear any existing timers
    if (rebootTimer) clearTimeout(rebootTimer);
    if (warningTimer) clearTimeout(warningTimer);
    
    // Set warning timer for 29 minutes (1 minute before reboot)
    warningTimer = setTimeout(() => {
        // Send warning to all users
        room.send({
            type: 'reboot_warning',
            payload: { 
                message: 'System will restart in 1 minute to maintain connection stability. Please save any work.',
                timeRemaining: 60
            }
        });
        
        // Show local warning for creator
        showRebootWarning(60);
    }, 29 * 60 * 1000); // 29 minutes
    
    // Set reboot timer for 30 minutes
    rebootTimer = setTimeout(() => {
        console.log('Auto-rebooting to refresh realtime connection...');
        window.location.reload();
    }, 30 * 60 * 1000); // 30 minutes
}

function showRebootWarning(seconds) {
    // Create or update warning banner
    let warningBanner = document.getElementById('reboot-warning');
    if (!warningBanner) {
        warningBanner = document.createElement('div');
        warningBanner.id = 'reboot-warning';
        warningBanner.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: #ff6b35;
            color: white;
            padding: 1rem;
            text-align: center;
            font-weight: 500;
            z-index: 1000;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        `;
        document.body.appendChild(warningBanner);
        document.body.style.paddingTop = '60px'; // Adjust body padding
    }
    
    const updateWarning = (timeLeft) => {
        warningBanner.textContent = `System will restart in ${timeLeft} seconds to maintain connection stability. Please save any work.`;
        
        if (timeLeft > 0) {
            setTimeout(() => updateWarning(timeLeft - 1), 1000);
        }
    };
    
    updateWarning(seconds);
}

function setupEventListeners() {
    manualBuildBtn.addEventListener('click', handleManualBuildClick);

    room.onmessage = (event) => {
        const { type, payload, targetClientId } = event.data;

        // Handle creator-side events
        if (isCreator && type === 'build_request') {
            if (bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
                console.log('Received build request, forwarding to bridge:', payload);
                activeBuilds[payload.requestId] = { fromClientId: payload.fromClientId };
                bridgeSocket.send(JSON.stringify({ type: 'start_build', ...payload }));
            } else {
                console.warn('Build request received, but bridge is not connected.');
                room.send({
                    type: 'build_failed',
                    targetClientId: payload.fromClientId,
                    payload: { error: 'Creator is not ready to build. The bridge is disconnected.' }
                });
            }
        }

        // Handle reboot warning for all users
        if (type === 'reboot_warning') {
            showRebootWarning(payload.timeRemaining);
        }

        // Handle user-side events (targeted messages)
        if (targetClientId && targetClientId !== room.clientId) {
            return;
        }

        if (type === 'build_complete') {
            updateStatus('Build complete! Your download is ready.', 100);
            downloadLink.href = payload.url;
            downloadLink.download = payload.fileName || `${payload.appName}.zip`;
            downloadLinkContainer.classList.remove('hidden');
            disableAllBuildButtons(false);
        }

        if (type === 'build_failed') {
            updateStatus(`Build failed: ${payload.error}`, 100);
            progressBar.style.backgroundColor = 'var(--error-color)';
            disableAllBuildButtons(false);
        }
    };
}

main();