/**
 * Discord Rich Presence (RPC) côté main process.
 *
 * Active seulement si `DISCORD_RPC_CLIENT_ID` est défini dans l'environnement.
 * Exemple Windows (PowerShell) :
 *   $env:DISCORD_RPC_CLIENT_ID="XXXXXXXXXXXXXXX"
 *   npm start
 */
'use strict';

const RPC = require('discord-rpc');

let client = null;
let enabled = false;
let lastActivity = null;
let sessionStartTimestamp = null;

// Valeur par défaut (tu m'as donné l'ID)
const DEFAULT_DISCORD_RPC_CLIENT_ID = '1483846619282800863';

function getClientId() {
  return process.env.DISCORD_RPC_CLIENT_ID || DEFAULT_DISCORD_RPC_CLIENT_ID || '';
}

function buildActivity({ state, details, startTimestamp, buttons } = {}) {
  const activity = {
    state: state || 'VibeLauncher',
    details: details || 'Minecraft',
  };
  if (startTimestamp) activity.startTimestamp = startTimestamp;
  if (Array.isArray(buttons) && buttons.length) activity.buttons = buttons;
  return activity;
}

async function initDiscordRpc() {
  if (enabled) return;
  const clientId = getClientId();
  if (!clientId) {
    enabled = false;
    return;
  }

  enabled = true;
  client = new RPC.Client({ transport: 'ipc' });

  try {
    // login() sans scopes = connexion et event "ready" (selon lib)
    await client.login({ clientId });
  } catch (e) {
    enabled = false;
    client = null;
    lastActivity = null;
    throw e;
  }
}

async function safeSetActivity(activity) {
  if (!enabled || !client) return;
  try {
    lastActivity = activity;
    await client.setActivity(activity);
  } catch (e) {
    // On ne casse jamais l'app à cause du RPC
    console.warn('[discord-rpc] setActivity failed:', e && e.message ? e.message : e);
  }
}

async function safeClearActivity() {
  if (!enabled || !client) return;
  try {
    lastActivity = null;
    await client.clearActivity();
  } catch (e) {
    console.warn('[discord-rpc] clearActivity failed:', e && e.message ? e.message : e);
  }
}

async function setMenuPresence() {
  // Présence "menu" pour que ça soit visible même hors lancement
  sessionStartTimestamp = null;
  await safeSetActivity(
    buildActivity({
      state: 'VibeLauncher',
      details: 'Dans le menu',
    })
  );
}

async function setLaunchingPresence({ version, loaderType, player, progress, phase } = {}) {
  if (!sessionStartTimestamp) sessionStartTimestamp = Date.now();
  const loader = loaderType ? ` (${loaderType})` : '';
  let details = version ? `Lancement ${version}${loader}` : `Lancement${loader}`;
  if (phase) details += ` • ${phase}`;
  if (typeof progress === 'number' && Number.isFinite(progress)) details += ` • ${progress}%`;

  await safeSetActivity(
    buildActivity({
      state: 'Minecraft',
      details,
      startTimestamp: sessionStartTimestamp,
      buttons: [
        { label: 'Discord', url: 'https://discord.gg/6r2eBCQD' },
        { label: 'VibeCraft', url: 'https://play.vibe-craft.fr' },
      ],
    })
  );
}

async function setPlayingPresence({ version, loaderType, player } = {}) {
  if (!sessionStartTimestamp) sessionStartTimestamp = Date.now();
  const loader = loaderType ? ` (${loaderType})` : '';
  const playerSuffix = player ? ` • ${player}` : '';
  await safeSetActivity(
    buildActivity({
      state: 'En jeu',
      details: version ? `Minecraft ${version}${loader}${playerSuffix}` : `Minecraft${loader}${playerSuffix}`,
      startTimestamp: sessionStartTimestamp,
      buttons: [
        { label: 'Discord', url: 'https://discord.gg/6r2eBCQD' },
        { label: 'VibeCraft', url: 'https://play.vibe-craft.fr' },
      ],
    })
  );
}

async function shutdownDiscordRpc() {
  if (!client) return;
  try {
    await client.destroy();
  } catch { /* ignore */ }
  client = null;
  enabled = false;
  lastActivity = null;
  sessionStartTimestamp = null;
}

module.exports = {
  initDiscordRpc,
  setMenuPresence,
  setLaunchingPresence,
  setPlayingPresence,
  shutdownDiscordRpc,
};

