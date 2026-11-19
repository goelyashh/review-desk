const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('api', {
  init: call('init'), scan: call('scan'), mediaUrl: call('media-url'), probe: call('probe'),
  notesLoad: call('notes-load'), notesSave: call('notes-save'), notesMarkdown: call('notes-markdown'),
  snapshotSave: call('snapshot-save'), snapshotDelete: call('snapshot-delete'),
  proxyExists: call('proxy-exists'), proxyMake: call('proxy-make'),
  copy: call('copy'), reveal: call('reveal'), openPath: call('open-path'),
  recentAdd: call('recent-add'), recentClear: call('recent-clear'),
  chooseRoot: call('choose-root'), projectCreate: call('project-create'),
  pickVideos: call('pick-videos'), importVideos: call('import'),
  capture: call('capture'), test: call('test'), selftestDone: call('selftest-done'),
  filePath: (f) => webUtils.getPathForFile(f),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, d) => fn(d)),
});
