require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  MessageFlags,
  REST,
  Routes,
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  StreamType,
} = require('@discordjs/voice');

const REQUIRED = [
  'DISCORD_TOKEN',
  'GUILD_ID',
  'WAITING_VOICE_CHANNEL_ID',
  'REQUESTS_TEXT_CHANNEL_ID',
  'GAME_VOICE_CHANNEL_ID',
  'GUEST_ROLE_ID',
];

for (const key of REQUIRED) {
  if (!process.env[key] || process.env[key].startsWith('PUT_')) {
    console.error(`Falta configurar ${key} en el archivo .env`);
    process.exit(1);
  }
}

function csv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !item.startsWith('PUT_'));
}

function bool(value, fallback = 'true') {
  return String(value ?? fallback).toLowerCase() === 'true';
}

const config = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID,
  waitingVoiceId: process.env.WAITING_VOICE_CHANNEL_ID,
  requestsTextId: process.env.REQUESTS_TEXT_CHANNEL_ID,
  gameVoiceId: process.env.GAME_VOICE_CHANNEL_ID,
  guestRoleId: process.env.GUEST_ROLE_ID,
  allowedUserIds: csv(process.env.MATAVIEJA_USER_IDS),
  allowedRoleIds: csv(process.env.MATAVIEJA_ROLE_IDS),
  eventDay: Number(process.env.EVENT_DAY || 5),
  timeZone: process.env.TIME_ZONE || 'America/New_York',
  fridayOnly: bool(process.env.FRIDAY_ONLY),
  cancelWhenLeaving: bool(process.env.CANCEL_WHEN_LEAVING_WAITING),
  autoRequest: bool(process.env.AUTO_REQUEST_ON_JOIN),
  // Música de espera
  musicEnabled: bool(process.env.WAITING_MUSIC_ENABLED),
  musicPath: process.env.WAITING_MUSIC_PATH || path.join(__dirname, '..', 'assets', 'espera.mp3'),
  musicVolume: Math.min(Math.max(Number(process.env.WAITING_MUSIC_VOLUME || 0.25), 0), 1),
  musicSelfDeaf: bool(process.env.WAITING_MUSIC_SELF_DEAF),
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.GuildMember, Partials.User, Partials.Channel],
});

// userId -> { messageId, createdAt }
const pending = new Map();
// userId -> { acceptedAt }
const activeGuests = new Map();

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

/* ------------------------------------------------------------------ */
/* MÚSICA DE ESPERA EN BUCLE                                           */
/* ------------------------------------------------------------------ */

let audioPlayer = null;
let musicAvailable = config.musicEnabled;

function buildResource() {
  const resource = createAudioResource(fs.createReadStream(config.musicPath), {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
  });
  resource.volume?.setVolume(config.musicVolume);
  return resource;
}

function getPlayer() {
  if (audioPlayer) return audioPlayer;

  audioPlayer = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });

  // Bucle infinito: al terminar la pista vuelve a empezar.
  audioPlayer.on(AudioPlayerStatus.Idle, () => {
    const connection = getVoiceConnection(config.guildId);
    if (!connection || !musicAvailable) return;
    try {
      audioPlayer.play(buildResource());
    } catch (error) {
      console.error('No se pudo reiniciar la música de espera:', error);
    }
  });

  audioPlayer.on('error', (error) => {
    console.error('Error del reproductor de audio:', error.message);
  });

  return audioPlayer;
}

function humansIn(channel) {
  if (!channel) return 0;
  return channel.members.filter((m) => !m.user.bot).size;
}

async function startWaitingMusic(waitingChannel) {
  if (!musicAvailable) return;

  if (!fs.existsSync(config.musicPath)) {
    console.error(`No encuentro el archivo de música: ${config.musicPath}. Música desactivada.`);
    musicAvailable = false;
    return;
  }

  let connection = getVoiceConnection(waitingChannel.guild.id);
  if (!connection) {
    connection = joinVoiceChannel({
      channelId: waitingChannel.id,
      guildId: waitingChannel.guild.id,
      adapterCreator: waitingChannel.guild.voiceAdapterCreator,
      selfDeaf: config.musicSelfDeaf,
      selfMute: false,
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        connection.destroy();
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    } catch (error) {
      console.error('No pude conectarme al canal de espera:', error.message);
      connection.destroy();
      return;
    }
  }

  const player = getPlayer();
  connection.subscribe(player);

  if (player.state.status !== AudioPlayerStatus.Playing) {
    player.play(buildResource());
  }
}

function stopWaitingMusic(guildId) {
  const connection = getVoiceConnection(guildId);
  if (audioPlayer) audioPlayer.stop(true);
  if (connection) connection.destroy();
}

// Entra cuando hay gente esperando, sale cuando la sala queda vacía.
async function syncWaitingMusic(guild) {
  if (!musicAvailable || !guild) return;
  try {
    const waiting = await getChannel(guild, config.waitingVoiceId);
    if (!waiting) return;

    if (humansIn(waiting) > 0) await startWaitingMusic(waiting);
    else stopWaitingMusic(guild.id);
  } catch (error) {
    console.error('Error sincronizando la música de espera:', error.message);
  }
}

/* ------------------------------------------------------------------ */
/* LÓGICA DEL CALL CENTER                                              */
/* ------------------------------------------------------------------ */

function isEventDay() {
  if (!config.fridayOnly) return true;
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timeZone,
    weekday: 'short',
  }).format(new Date());
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return days[weekday] === config.eventDay;
}

function isAuthorized(interaction) {
  if (config.allowedUserIds.includes(interaction.user.id)) return true;
  const memberRoleIds = interaction.member?.roles?.cache
    ? [...interaction.member.roles.cache.keys()]
    : [];
  return config.allowedRoleIds.some((roleId) => memberRoleIds.includes(roleId));
}

function requestEmbed(member, status = '🟡 EN ESPERA') {
  const color = status.includes('ACEPT')
    ? 0x2ecc71
    : status.includes('DECLIN') || status.includes('CANCEL')
      ? 0xe74c3c
      : 0xf1c40f;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle('🎮 SOLICITUD PARA JUGAR')
    .setDescription([
      `👤 **Jugador:** <@${member.id}>`,
      `🎧 **Canal:** <#${config.waitingVoiceId}>`,
      `📌 **Estado:** ${status}`,
      '',
      'El jugador debe permanecer en el canal de espera hasta que MATAVIEJA responda.',
    ].join('\n'))
    .setTimestamp();
}

function requestButtons(userId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cc_accept:${userId}`)
      .setLabel('ACEPTAR')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`cc_decline:${userId}`)
      .setLabel('DECLINAR')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

async function getChannel(guild, id) {
  return guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
}

async function getMember(guild, userId) {
  return guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
}

async function getRequestsChannel(guild) {
  const channel = await getChannel(guild, config.requestsTextId);
  if (!channel || !channel.isTextBased()) {
    throw new Error('REQUESTS_TEXT_CHANNEL_ID no es un canal de texto válido.');
  }
  return channel;
}

async function createRequest(member) {
  if (!member || member.user.bot) return;
  if (!isEventDay()) return;
  if (pending.has(member.id) || activeGuests.has(member.id)) return;

  const channel = await getRequestsChannel(member.guild);
  const message = await channel.send({
    content: `📣 Nueva solicitud: <@${member.id}>`,
    embeds: [requestEmbed(member)],
    components: [requestButtons(member.id)],
  });

  pending.set(member.id, { messageId: message.id, createdAt: Date.now() });
}

async function updateRequest(guild, userId, status, disableButtons = true) {
  const request = pending.get(userId);
  if (!request) return;
  const channel = await getRequestsChannel(guild);
  const message = await channel.messages.fetch(request.messageId).catch(() => null);
  const member = await getMember(guild, userId);
  if (message && member) {
    await message.edit({
      embeds: [requestEmbed(member, status)],
      components: [requestButtons(userId, disableButtons)],
    }).catch(() => null);
  }
}

async function acceptRequest(interaction, userId) {
  const guild = interaction.guild;
  const member = await getMember(guild, userId);
  const game = await getChannel(guild, config.gameVoiceId);
  const role = guild.roles.cache.get(config.guestRoleId)
    || await guild.roles.fetch(config.guestRoleId).catch(() => null);

  if (!member || !game || !role) {
    await interaction.reply({ content: '⚠️ No se encontró el jugador, canal o rol configurado.', ...EPHEMERAL });
    return;
  }
  if (!pending.has(userId)) {
    await interaction.reply({ content: '⚠️ Esta solicitud ya no está pendiente.', ...EPHEMERAL });
    return;
  }
  if (member.voice.channelId !== config.waitingVoiceId) {
    await updateRequest(guild, userId, '⚠️ CANCELADA: ya no está en espera');
    pending.delete(userId);
    await interaction.reply({ content: '⚠️ El jugador ya no está en el canal de espera.', ...EPHEMERAL });
    return;
  }

  let roleAdded = false;
  try {
    await member.roles.add(role, 'Aceptado para jugar con la comunidad de MATAVIEJA');
    roleAdded = true;
    await member.voice.setChannel(game, 'Aceptado para jugar con la comunidad de MATAVIEJA');
    activeGuests.set(userId, { acceptedAt: Date.now() });
    await updateRequest(guild, userId, '✅ ACEPTADO');
    pending.delete(userId);
    await interaction.reply({ content: `✅ <@${userId}> fue aceptado y movido a <#${config.gameVoiceId}>.`, ...EPHEMERAL });
  } catch (error) {
    console.error('Error aceptando solicitud:', error);
    // Si el rol se asignó pero el movimiento falló, lo revertimos para no dejar roles colgados.
    if (roleAdded) {
      await member.roles.remove(role, 'Rollback: no se pudo mover al canal de juego').catch(() => null);
    }
    await interaction.reply({
      content: '❌ No pude completar la aceptación. Revisa permisos de Move Members y Manage Roles, y la posición del rol del bot.',
      ...EPHEMERAL,
    });
  }
}

async function declineRequest(interaction, userId) {
  if (!pending.has(userId)) {
    await interaction.reply({ content: '⚠️ Esta solicitud ya no está pendiente.', ...EPHEMERAL });
    return;
  }
  await updateRequest(interaction.guild, userId, '❌ DECLINADO');
  pending.delete(userId);
  await interaction.reply({ content: `❌ Solicitud de <@${userId}> declinada.`, ...EPHEMERAL });
}

/* ------------------------------------------------------------------ */
/* EVENTOS                                                             */
/* ------------------------------------------------------------------ */

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Conectado como ${readyClient.user.tag}`);

  if (config.musicEnabled && !fs.existsSync(config.musicPath)) {
    console.warn(`⚠️ Música activada pero no existe el archivo: ${config.musicPath}`);
    musicAvailable = false;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName('callcenter-panel')
      .setDescription('Publica el panel informativo del Call Center de MATAVIEJA.')
      .setDMPermission(false),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    await rest.put(Routes.applicationGuildCommands(readyClient.user.id, config.guildId), { body: commands });
    console.log('Comando /callcenter-panel registrado.');
  } catch (error) {
    console.error('No se pudo registrar el comando:', error);
  }

  // Si el bot se reinicia mientras hay gente esperando, retoma la música.
  try {
    const guild = client.guilds.cache.get(config.guildId) || await client.guilds.fetch(config.guildId);
    await guild.members.fetch();
    await syncWaitingMusic(guild);
  } catch (error) {
    console.error('No pude sincronizar el estado inicial:', error.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'callcenter-panel') {
      if (!isAuthorized(interaction)) {
        await interaction.reply({ content: '⛔ No tienes permiso para usar este comando.', ...EPHEMERAL });
        return;
      }
      const channel = await getRequestsChannel(interaction.guild);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🎮 MATAVIEJA • SOLICITUDES PARA JUGAR')
        .setDescription([
          '1. Entra a `⏳・ESPERA-PARA-JUGAR`.',
          '2. El bot publicará tu solicitud automáticamente.',
          '3. Permanece en espera hasta que MATAVIEJA responda.',
          '',
          '🎵 Mientras esperas sonará la música de espera.',
          '📅 Evento de la comunidad de Kick: viernes.',
        ].join('\n'))
        .setFooter({ text: 'MATAVIEJA Community Call Center' });
      await channel.send({ embeds: [embed] });
      await interaction.reply({ content: '✅ Panel publicado.', ...EPHEMERAL });
      return;
    }

    if (interaction.isButton() && (interaction.customId.startsWith('cc_accept:') || interaction.customId.startsWith('cc_decline:'))) {
      if (!isAuthorized(interaction)) {
        await interaction.reply({ content: '⛔ Solo MATAVIEJA o el rol autorizado puede responder solicitudes.', ...EPHEMERAL });
        return;
      }
      const [action, userId] = interaction.customId.split(':');
      if (action === 'cc_accept') await acceptRequest(interaction, userId);
      else await declineRequest(interaction, userId);
    }
  } catch (error) {
    console.error('Error procesando interacción:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Ocurrió un error procesando la acción.', ...EPHEMERAL }).catch(() => null);
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const member = newState.member || oldState.member;
    const guild = newState.guild || oldState.guild;

    // El propio bot cambiando de estado no debe disparar lógica de jugadores.
    if (!member || member.user.bot) {
      if (member?.id === client.user.id && oldState.channelId && !newState.channelId) {
        if (audioPlayer) audioPlayer.stop(true);
      }
      return;
    }

    // Crear solicitud al entrar a la sala de espera.
    if (config.autoRequest && newState.channelId === config.waitingVoiceId && oldState.channelId !== config.waitingVoiceId) {
      await createRequest(member);
    }

    // Cancelar solicitud al salir de la sala de espera.
    if (config.cancelWhenLeaving && oldState.channelId === config.waitingVoiceId && newState.channelId !== config.waitingVoiceId) {
      if (pending.has(member.id)) {
        await updateRequest(guild, member.id, '⚠️ CANCELADA: salió de espera');
        pending.delete(member.id);
      }
    }

    // Quitar el rol de invitado al salir de la sala de juego.
    if (oldState.channelId === config.gameVoiceId && newState.channelId !== config.gameVoiceId) {
      if (activeGuests.has(member.id)) {
        const role = guild.roles.cache.get(config.guestRoleId)
          || await guild.roles.fetch(config.guestRoleId).catch(() => null);
        if (role) await member.roles.remove(role, 'El jugador salió de la sala de juego').catch(() => null);
        activeGuests.delete(member.id);
      }
    }

    // Música: entrar o salir según haya gente en espera.
    if (oldState.channelId === config.waitingVoiceId || newState.channelId === config.waitingVoiceId) {
      await syncWaitingMusic(guild);
    }
  } catch (error) {
    console.error('Error en VoiceStateUpdate:', error);
  }
});

process.on('SIGINT', () => { stopWaitingMusic(config.guildId); process.exit(0); });
process.on('SIGTERM', () => { stopWaitingMusic(config.guildId); process.exit(0); });

client.login(config.token);
