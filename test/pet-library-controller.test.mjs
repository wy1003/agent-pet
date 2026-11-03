import test from "node:test";
import assert from "node:assert/strict";
import { PetLibraryController } from "../public/pet-library-controller.js";
import { petPreview } from "../public/pet-library-view.js";

function harness() {
  let state = { selectedPetId: "active", pets: [
    { id: "active", displayName: "正在使用的宠物" },
    { id: "other", displayName: "准备删除的宠物" },
  ] };
  const calls = [], prompts = [], messages = [], busy = [], renders = [];
  const api = {
    getPetLibrary: async () => structuredClone(state),
    selectPet: async id => { calls.push(["select", id]); state.selectedPetId = id; return structuredClone(state); },
    removePet: async id => {
      calls.push(["remove", id]);
      state.pets = state.pets.filter(pet => pet.id !== id);
      if (state.selectedPetId === id) state.selectedPetId = "builtin-default";
      return structuredClone(state);
    },
    selectPetZip: async () => ({ canceled: true }),
    importPetZip: async file => { calls.push(["import", file]); return structuredClone(state); },
  };
  const context = { accept: true, api, calls, prompts, messages, busy, renders };
  context.controller = new PetLibraryController({ api,
    view: {
      render: value => renders.push(structuredClone(value)),
      setBusy: value => busy.push(value),
      status: (state, message) => messages.push({ state, message }),
    },
    confirm: message => { prompts.push(message); return context.accept; },
  });
  return context;
}

test("deleting another card targets that pet without changing the active pet", async () => {
  const h = harness();
  await h.controller.load();
  assert.equal(await h.controller.remove("other"), true);
  assert.deepEqual(h.calls, [["remove", "other"]]);
  assert.equal(h.controller.state.selectedPetId, "active");
  assert.deepEqual(h.controller.state.pets.map(p => p.id), ["active"]);
  assert.match(h.prompts[0], /准备删除的宠物/);
  assert.doesNotMatch(h.prompts[0], /切换为/);
  assert.doesNotMatch(h.messages.at(-1).message, /切换为/);
});

test("deleting the active card explains fallback before confirmation and displays host selection", async () => {
  const h = harness();
  await h.controller.load();
  await h.controller.remove("active");
  assert.match(h.prompts[0], /正在使用.*删除后会切换为内置宠物“小团”/);
  assert.equal(h.controller.state.selectedPetId, "builtin-default");
  assert.match(h.messages.at(-1).message, /已切换为内置宠物“小团”/);
  assert.deepEqual(h.calls, [["remove", "active"]]);
});

test("canceling deletion, built-in and stale card IDs never delete or select a pet", async () => {
  const h = harness();
  await h.controller.load();
  h.accept = false;
  for (const id of ["other", "active", "builtin-default", "missing"]) {
    assert.equal(await h.controller.remove(id), false);
  }
  assert.equal(await h.controller.select("missing"), false);
  assert.equal(await h.controller.select("active"), false);
  assert.deepEqual(h.calls, []);
  assert.equal(h.controller.state.selectedPetId, "active");
  assert.equal(h.prompts.length, 2);
});

test("selecting a card switches only the selected pet, including the built-in pet", async () => {
  const h = harness();
  await h.controller.load();
  await h.controller.select("other");
  await h.controller.select("builtin-default");
  assert.deepEqual(h.calls, [["select", "other"], ["select", "builtin-default"]]);
  assert.equal(h.controller.state.pets.length, 2);
});

test("failed deletion keeps the card and active selection, restores controls and reports error", async () => {
  const h = harness();
  await h.controller.load();
  h.api.removePet = async () => { throw new Error("文件被占用"); };
  assert.equal(await h.controller.remove("other"), false);
  assert.equal(h.controller.state.pets.length, 2);
  assert.equal(h.controller.state.selectedPetId, "active");
  assert.deepEqual(h.busy, [true, false]);
  assert.equal(h.messages.at(-1).state, "error");
  assert.match(h.messages.at(-1).message, /文件被占用/);
});

test("pending file picker blocks simultaneous deletion, selection, and duplicate import", async () => {
  const h = harness();
  await h.controller.load();
  let finish;
  h.api.selectPetZip = () => new Promise(resolve => { finish = resolve; });
  const pending = h.controller.chooseArchive();
  assert.equal(h.controller.busy, true);
  assert.equal(await h.controller.remove("other"), false);
  assert.equal(await h.controller.select("other"), false);
  assert.equal(await h.controller.importArchive("second.zip"), false);
  finish({ canceled: false, path: "first.zip" });
  assert.equal(await pending, true);
  assert.deepEqual(h.calls, [["import", "first.zip"]]);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.controller.busy, false);
});

test("canceled picker and invalid archive preserve the library", async () => {
  const h = harness();
  await h.controller.load();
  assert.equal(await h.controller.chooseArchive(), false);
  assert.equal(await h.controller.importArchive("bad.exe"), false);
  assert.deepEqual(h.calls, []);
  assert.match(h.messages.at(-1).message, /ZIP/);
  assert.equal(h.controller.busy, false);
});

test("preview uses the built-in image, GIF fallback or the correct v1/v2 sprite grid", () => {
  assert.equal(petPreview({ id: "builtin-default" }).url, "/assets/pets/builtin-default/builtin-default-idle.gif");
  assert.deepEqual(petPreview({ id: "custom", format: "state-gifs", states: { waving: "custom waving.gif" } }), {
    url: "pet-asset://library/custom/custom%20waving.gif", rows: 1, columns: 1,
  });
  for (const [version, rows] of [[1, 9], [2, 11]]) {
    assert.deepEqual(petPreview({ id: "sheet", format: "spritesheet", spritesheetPath: "a#b.png", spriteVersionNumber: version }), {
      url: "pet-asset://library/sheet/a%23b.png", rows, columns: 8,
    });
  }
  assert.equal(petPreview({ id: "no-image", states: {} }), null);
});
