import { v } from 'convex/values';
import { api, internal } from './_generated/api';
import { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { getAgentSnapshot } from './engine';
import { getAllPlayers } from './players';
import { asyncMap } from './lib/utils';
import { Action, Entry, EntryOfType } from './types';
import { clientMessageMapper } from './chat';
import { MemoryDB } from './lib/memory';
import { converse, startConversation, walkAway } from './conversation';
import { Message } from './lib/openai';

export const debugAgentSnapshot = internalMutation({
  args: { playerId: v.id('players') },
  handler: async (ctx, { playerId }) => {
    const snapshot = await getAgentSnapshot(ctx, playerId);
    const thinkId = await ctx.db.insert('journal', {
      playerId,
      data: {
        type: 'thinking',
        snapshot,
      },
    });
    return { snapshot, thinkId };
  },
});

export const getDebugPlayerIds = internalQuery({
  handler: async (ctx) => {
    const world = await ctx.db.query('worlds').order('desc').first();
    if (!world) throw new Error('No worlds exist yet: try running dbx convex run init');
    const players = await getAllPlayers(ctx.db, world._id);
    return { playerIds: players.map((p) => p._id), world };
  },
});

export const debugPlayerSnapshot = internalQuery({
  args: {},
  handler: async (ctx, args) => {
    const player = await ctx.db.query('players').first();
    if (!player) return null;
    const snapshot = await getAgentSnapshot(ctx, player._id);
    return snapshot;
  },
});

export const debugListMessages = internalQuery({
  args: {},
  handler: async (ctx, args) => {
    const world = await ctx.db.query('worlds').order('desc').first();
    if (!world) return [];
    const players = await getAllPlayers(ctx.db, world._id);
    const playerIds = players.map((p) => p._id);
    const messageEntries = await asyncMap(
      playerIds,
      (playerId) =>
        ctx.db
          .query('journal')
          .withIndex('by_playerId_type', (q) =>
            q.eq('playerId', playerId as any).eq('data.type', 'talking'),
          )
          .collect() as Promise<EntryOfType<'talking'>[]>,
    );
    return (
      await asyncMap(
        messageEntries.flatMap((a) => a),
        clientMessageMapper(ctx.db),
      )
    ).sort((a, b) => a.ts - b.ts);
  },
});

// For making conversations happen without walking around.
export const runConversation = internalAction({
  args: { numPlayers: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    // To always clear all first:
    await ctx.runAction(internal.init.resetFrozen);
    // To always make a new world:
    // await ctx.runAction(internal.init.seed, { newWorld: true });
    // To just run with the existing agents:
    //await ctx.runAction(internal.init.seed, {});

    // Grabs the latest world
    const { playerIds, world } = await ctx.runQuery(internal.testing.getDebugPlayerIds);
    const memory = MemoryDB(ctx);
    let done = false;

    let firstTime = true;
    let ourConversationId: Id<'conversations'> | null = null;
    while (!done) {
      for (const playerId of playerIds) {
        const { snapshot, thinkId } = await ctx.runMutation(internal.testing.debugAgentSnapshot, {
          playerId,
        });
        const actionAPI = (action: Action) =>
          ctx.runMutation(internal.engine.handleAgentAction, {
            playerId,
            action,
            noSchedule: true,
          });
        const { player, nearbyPlayers, nearbyConversations } = snapshot;
        if (nearbyPlayers.find(({ player }) => player.thinking)) {
          throw new Error('Unexpected thinking player ' + playerId);
        }
        const newFriends = nearbyPlayers.filter((a) => a.new).map(({ player }) => player);
        if (firstTime) {
          firstTime = false;
          if (nearbyConversations.length) {
            throw new Error('Unexpected conversations taking place');
          }
          const conversationEntry = (await actionAPI({
            type: 'startConversation',
            audience: newFriends.map((a) => a.id),
          })) as EntryOfType<'startConversation'>;
          if (!conversationEntry) throw new Error('Unexpected failure to start conversation');
          const newFriendsNames = newFriends.map((a) => a.name);
          const playerCompletion = await startConversation(newFriendsNames, memory, player);
          if (
            !(await actionAPI({
              type: 'talking',
              audience: newFriends.map((a) => a.id),
              content: playerCompletion,
              conversationId: conversationEntry.data.conversationId,
            }))
          )
            throw new Error('Unexpected failure to start conversation');
        } else {
          if (nearbyConversations.length !== 1) {
            throw new Error('Unexpected conversations taking place');
          }
          const { conversationId, messages } = nearbyConversations[0];
          if (!ourConversationId) {
            ourConversationId = conversationId;
          } else {
            if (conversationId !== ourConversationId) {
              throw new Error(
                'Unexpected conversationId ' + conversationId + ' != ' + ourConversationId,
              );
            }
          }
          const chatHistory: Message[] = [
            ...messages.map((m) => ({
              role: 'user' as const,
              content: `${m.fromName} to ${m.toNames.join(',')}: ${m.content}\n`,
            })),
          ];
          const shouldWalkAway = await walkAway(chatHistory, player);
          if (shouldWalkAway) {
            done = true;
            await actionAPI({ type: 'done', thinkId });
            break;
          }
          const playerCompletion = await converse(chatHistory, player, nearbyPlayers, memory);
          // display the chat via actionAPI
          await actionAPI({
            type: 'talking',
            audience: nearbyPlayers.map(({ player }) => player.id),
            content: playerCompletion,
            conversationId: conversationId,
          });
        }
        await actionAPI({ type: 'done', thinkId });
      }
    }
    if (!ourConversationId) throw new Error('No conversationId');
    for (const playerId of playerIds) {
      await memory.rememberConversation(playerId, ourConversationId, Date.now());
    }
  },
});