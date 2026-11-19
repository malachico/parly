import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp, createHub } from '../src/app.js';
import { MemoryFileStore } from '../src/files/store.js';
import { crew, newAgentOverHttp, testConfig, testDb, testPerson } from './helpers.js';

const canvas = { x: 40, y: 80, w: 320, h: 260 };
async function setup() {
  const hub = createHub({ db: testDb(), config: testConfig(), fileStore: new MemoryFileStore() });
  const { owner, workspace } = await crew(hub.registry, 'notes', []);
  const author = await testPerson(hub.registry, 'Author');
  const member = await testPerson(hub.registry, 'Reader');
  await hub.registry.inviteToWorkspace(owner, workspace.id, author.email!);
  await hub.registry.inviteToWorkspace(owner, workspace.id, member.email!);
  return { hub, owner, workspace, author: (await hub.registry.get(author.id))!, member: (await hub.registry.get(member.id))! };
}

describe('workspace canvas notes', () => {
  it('persists Markdown and GIFs; scopes attachment reads without changing generic file access', async () => {
    const { hub, owner, workspace, author, member } = await setup();
    const file = await hub.files.uploadInline(author, { name: 'demo.gif', mediaType: 'image/gif', contentBase64: Buffer.from('GIF89a').toString('base64') });
    const note = await hub.notes.save(author, workspace.id, { text: '**Plan**\n- Ship it', files: [file.id], canvas, authorId: owner.id });
    expect(note.authorId).toBe(author.id);
    expect(note.files).toEqual([{ id: file.id, name: 'demo.gif', mediaType: 'image/gif' }]);
    expect(await hub.notes.list(member, workspace.id)).toEqual([note]);
    expect((await hub.notes.file(member, workspace.id, note.id, file.id)).id).toBe(file.id);
    await expect(hub.fileForDownload(member, file.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(hub.notes.file(member, workspace.id, note.id, 'not-attached')).rejects.toMatchObject({ code: 'not_found' });
    const moved = await hub.notes.save(owner, workspace.id, { version: note.version, canvas: { ...canvas, x: 200 } }, note.id);
    expect(moved.text).toBe(note.text);
    expect(moved.files).toEqual(note.files);
    expect(moved.canvas.x).toBe(200);
    await hub.notes.delete(author, workspace.id, note.id, moved.version);
    await expect(hub.notes.file(member, workspace.id, note.id, file.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('blocks outsiders, cross-workspace note ids, member writes and showcase-guest writes (guests can still read)', async () => {
    const { hub, owner, workspace, author, member } = await setup();
    const note = await hub.notes.save(author, workspace.id, { text: 'Private', canvas });
    const outsider = await testPerson(hub.registry, 'Outsider');
    await expect(hub.notes.list(outsider, workspace.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(hub.notes.save(member, workspace.id, { text: 'changed', version: 1 }, note.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(hub.notes.delete(member, workspace.id, note.id, 1)).rejects.toMatchObject({ code: 'forbidden' });
    const other = await hub.registry.createWorkspace(owner, 'Other');
    await expect(hub.notes.get(owner, other.id, note.id)).rejects.toMatchObject({ code: 'not_found' });
    await hub.registry.setWorkspacePublicShowcase(owner, workspace.id, true);
    expect(await hub.notes.list(author, workspace.id)).toHaveLength(1);
    expect((await hub.notes.get(author, workspace.id, note.id)).text).toBe('Private');
    await expect(hub.notes.save(author, workspace.id, { text: 'new', canvas })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(hub.notes.delete(author, workspace.id, note.id, 1)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await hub.notes.list(owner, workspace.id)).toHaveLength(1);
  });

  it('validates content, geometry and ownership of new attachments', async () => {
    const { hub, owner, workspace, author } = await setup();
    for (const body of [null, [], {}, { text: '', canvas }, { text: 'x'.repeat(20_001), canvas }, { text: 'x', canvas: { ...canvas, w: -1 } }, { text: 'x', canvas: { ...canvas, x: Infinity } }, { text: 'x', canvas, files: [{}] }, { text: 'x', canvas, files: ['../bad'] }]) {
      await expect(hub.notes.save(author, workspace.id, body)).rejects.toMatchObject({ code: 'invalid' });
    }
    const ownFile = await hub.files.uploadInline(owner, { name: 'private.png', mediaType: 'image/png', contentBase64: 'aGk=' });
    await expect(hub.notes.save(author, workspace.id, { files: [ownFile.id], canvas })).rejects.toBeDefined();
    const svg = await hub.files.uploadInline(author, { name: 'active.svg', mediaType: 'image/svg+xml', contentBase64: 'aGk=' });
    await expect(hub.notes.save(author, workspace.id, { files: [svg.id], canvas })).rejects.toMatchObject({ code: 'invalid' });
    const image = await hub.files.uploadInline(author, { name: 'image.png', mediaType: 'image/png', contentBase64: 'aGk=' });
    expect((await hub.notes.save(author, workspace.id, { files: [image.id], canvas })).text).toBe('');
  });

  it('rejects stale and concurrent updates instead of losing newer edits', async () => {
    const { hub, workspace, author } = await setup();
    const note = await hub.notes.save(author, workspace.id, { text: 'Original', canvas });
    const results = await Promise.allSettled(['A', 'B'].map((text) => hub.notes.save(author, workspace.id, { text, version: 1 }, note.id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await expect(hub.notes.delete(author, workspace.id, note.id, 1)).rejects.toMatchObject({ code: 'conflict' });
    expect((await hub.notes.get(author, workspace.id, note.id)).version).toBe(2);
  });
});


describe('notes REST boundary', () => {
  it('requires authentication and exposes create/list/update/scoped files/delete', async () => {
    const { app, hub } = createApp({ db: testDb(), config: testConfig(), fileStore: new MemoryFileStore() });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { owner } = await newAgentOverHttp(url, { name: 'Note bot' });
      const path = `/workspaces/${owner.workspaceId}/notes`;
      const headers = { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' };
      expect((await fetch(url + path)).status).toBe(401);
      const file = await hub.files.uploadInline((await hub.registry.get(owner.id))!, { name: 'note.gif', mediaType: 'image/gif', contentBase64: 'R0lGODlh' });
      const created = await fetch(url + path, { method: 'POST', headers, body: JSON.stringify({ text: 'Hello', files: [file.id], canvas }) });
      expect(created.status).toBe(201);
      const { note } = await created.json() as { note: { id: string; version: number } };
      expect((await fetch(url + path, { headers })).status).toBe(200);
      const attachment = await fetch(`${url}${path}/${note.id}/files/${file.id}`, { headers });
      expect(attachment.status).toBe(200);
      expect(await attachment.json()).toHaveProperty('url');
      const changed = await fetch(`${url}${path}/${note.id}`, { method: 'PATCH', headers, body: JSON.stringify({ text: 'Updated', version: note.version }) });
      expect(changed.status).toBe(200);
      expect((await fetch(`${url}${path}/${note.id}`, { method: 'DELETE', headers, body: JSON.stringify({ version: 2 }) })).status).toBe(200);
      expect((await fetch(`${url}${path}/${note.id}/files/${file.id}`, { headers })).status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
