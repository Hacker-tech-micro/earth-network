const { createClient } = window.supabase;
const config = window.EARTH_NETWORK_CONFIG;

const MAX_MESSAGE_LENGTH = 280;
const MAX_USERNAME_LENGTH = 24;
const MESSAGE_PAGE_SIZE = 100;
const CHANNEL_NAME = 'earth-network-global';
const USERNAME_KEY = 'earth_network_username';

const elements = {
  messages: document.getElementById('chatMessages'),
  messageForm: document.getElementById('messageForm'),
  messageInput: document.getElementById('messageInput'),
  sendButton: document.getElementById('sendButton'),
  onlineCount: document.getElementById('onlineCount'),
  currentUsername: document.getElementById('currentUsername'),
  nameButton: document.getElementById('nameButton'),
  charCount: document.getElementById('charCount'),
  errorBar: document.getElementById('errorBar'),
  loadingState: document.getElementById('loadingState'),
  nameModal: document.getElementById('nameModal'),
  closeModal: document.getElementById('closeModal'),
  nameInput: document.getElementById('nameInput'),
  saveName: document.getElementById('saveName'),
  randomName: document.getElementById('randomName'),
  nameError: document.getElementById('nameError')
};

let supabaseClient;
let currentUser = null;
let currentUsername = '';
let globalChannel = null;
let renderedMessageIds = new Set();
let lastSentAt = 0;

function showError(message) {
  elements.errorBar.textContent = message;
  elements.errorBar.hidden = false;
  window.clearTimeout(showError.timeout);
  showError.timeout = window.setTimeout(() => {
    elements.errorBar.hidden = true;
  }, 5000);
}

function randomUsername() {
  return `Guest_${Math.floor(1000 + Math.random() * 9000)}`;
}

function getUsername() {
  const saved = localStorage.getItem(USERNAME_KEY);
  return saved && /^[A-Za-z0-9_-]{2,24}$/.test(saved) ? saved : randomUsername();
}

function setUsername(name) {
  currentUsername = name;
  localStorage.setItem(USERNAME_KEY, name);
  elements.currentUsername.textContent = name;
  elements.nameInput.value = name;
  if (globalChannel) {
    globalChannel.track({ username: name, online_at: new Date().toISOString() }).catch(() => {});
  }
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function addMessage(message, forceScroll = false) {
  if (!message || renderedMessageIds.has(message.id)) return;
  renderedMessageIds.add(message.id);

  if (elements.loadingState) elements.loadingState.remove();

  const row = document.createElement('article');
  row.className = 'message-row' + (message.user_id === currentUser?.id ? ' mine' : '');

  const content = document.createElement('div');
  content.className = 'message-content';

  const meta = document.createElement('div');
  meta.className = 'message-meta';

  const username = document.createElement('span');
  username.className = 'username';
  username.textContent = message.username;

  const time = document.createElement('time');
  time.className = 'time';
  time.dateTime = message.created_at;
  time.textContent = formatTime(message.created_at);

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  // textContent prevents HTML/script injection.
  bubble.textContent = message.message;

  meta.append(username, time);
  content.append(meta, bubble);
  row.append(content);
  elements.messages.append(row);

  const distanceFromBottom = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight;
  if (forceScroll || distanceFromBottom < 180 || message.user_id === currentUser?.id) {
    requestAnimationFrame(() => {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    });
  }
}

async function loadMessages() {
  const { data, error } = await supabaseClient
    .from('messages')
    .select('id, username, message, created_at, user_id')
    .order('created_at', { ascending: false })
    .limit(MESSAGE_PAGE_SIZE);

  if (error) throw error;

  data.reverse().forEach((message) => addMessage(message));
  requestAnimationFrame(() => {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  });
}

function updateOnlineCount() {
  if (!globalChannel) return;
  const state = globalChannel.presenceState();
  elements.onlineCount.textContent = Object.keys(state).length;
}

async function setupRealtime() {
  globalChannel = supabaseClient.channel(CHANNEL_NAME, {
    config: { presence: { key: currentUser.id } }
  });

  globalChannel
    .on('presence', { event: 'sync' }, updateOnlineCount)
    .on('presence', { event: 'join' }, updateOnlineCount)
    .on('presence', { event: 'leave' }, updateOnlineCount)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'messages'
    }, (payload) => addMessage(payload.new, true))
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await globalChannel.track({
          username: currentUsername,
          online_at: new Date().toISOString()
        });
        updateOnlineCount();
      }
    });
}

function validateUsername(name) {
  const clean = name.trim();
  if (clean.length < 2) return 'Username must be at least 2 characters.';
  if (clean.length > MAX_USERNAME_LENGTH) return `Username must be ${MAX_USERNAME_LENGTH} characters or fewer.`;
  if (!/^[A-Za-z0-9_-]+$/.test(clean)) return 'Use only letters, numbers, _ or -.';
  return '';
}

async function sendMessage() {
  const message = elements.messageInput.value.trim();
  if (!message) return;
  if (message.length > MAX_MESSAGE_LENGTH) {
    showError(`Message is limited to ${MAX_MESSAGE_LENGTH} characters.`);
    return;
  }

  const now = Date.now();
  if (now - lastSentAt < 1500) {
    showError('Please wait a moment before sending another message.');
    return;
  }

  elements.sendButton.disabled = true;
  lastSentAt = now;

  const { error } = await supabaseClient.from('messages').insert({
    username: currentUsername,
    message,
    user_id: currentUser.id
  });

  elements.sendButton.disabled = false;

  if (error) {
    lastSentAt = 0;
    if (/rate|spam|flood/i.test(error.message)) {
      showError('You are sending messages too quickly. Please wait a moment.');
    } else if (/inappropriate|blocked/i.test(error.message)) {
      showError('That message was blocked by the basic chat safety filter.');
    } else {
      showError('Could not send the message. Please try again.');
    }
    return;
  }

  elements.messageInput.value = '';
  elements.charCount.textContent = '0';
  elements.messageInput.focus();
}

function openNameModal() {
  elements.nameError.hidden = true;
  elements.nameInput.value = currentUsername;
  elements.nameModal.hidden = false;
  requestAnimationFrame(() => elements.nameInput.focus());
}

function closeNameModal() {
  elements.nameModal.hidden = true;
}

async function initialize() {
  if (!config?.supabaseUrl || config.supabaseUrl.includes('YOUR_') || !config.supabasePublishableKey || config.supabasePublishableKey.includes('YOUR_')) {
    elements.loadingState.textContent = 'Supabase is not configured. Check config.js.';
    showError('Open config.js and add your Supabase Project URL and publishable key.');
    return;
  }

  supabaseClient = createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  const { data: existingSession } = await supabaseClient.auth.getSession();
  if (existingSession.session?.user) {
    currentUser = existingSession.session.user;
  } else {
    const { data, error } = await supabaseClient.auth.signInAnonymously();
    if (error) throw error;
    currentUser = data.user;
  }

  currentUsername = getUsername();
  setUsername(currentUsername);

  await loadMessages();
  await setupRealtime();

  elements.messageInput.disabled = false;
  elements.sendButton.disabled = false;
  elements.loadingState?.remove();
  elements.messageInput.focus();
}

elements.messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage().catch(() => showError('Something went wrong while sending.'));
});

elements.messageInput.addEventListener('input', () => {
  elements.charCount.textContent = elements.messageInput.value.length;
});

elements.nameButton.addEventListener('click', openNameModal);
elements.closeModal.addEventListener('click', closeNameModal);
elements.nameModal.addEventListener('click', (event) => {
  if (event.target === elements.nameModal) closeNameModal();
});
elements.randomName.addEventListener('click', () => {
  elements.nameInput.value = randomUsername();
  elements.nameInput.focus();
});
elements.saveName.addEventListener('click', () => {
  const error = validateUsername(elements.nameInput.value);
  if (error) {
    elements.nameError.textContent = error;
    elements.nameError.hidden = false;
    return;
  }
  setUsername(elements.nameInput.value.trim());
  closeNameModal();
});

elements.nameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') elements.saveName.click();
  if (event.key === 'Escape') closeNameModal();
});

window.addEventListener('beforeunload', () => {
  if (globalChannel) globalChannel.untrack().catch(() => {});
});

initialize().catch((error) => {
  console.error(error);
  elements.loadingState.textContent = 'Could not connect. Check your Supabase settings and database setup.';
});
