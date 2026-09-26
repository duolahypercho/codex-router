- **Installing or refreshing the Codex skill pack works again on Node 26.10.**
  Node 26.10 made `fs.cpSync` refuse an existing destination directory under
  `errorOnExist` instead of merging into it (nodejs/node#64124). Skill
  publication claims its target with a no-replace `mkdir` and then copied the
  staged tree onto that directory, so every install and update failed with
  `ERR_FS_CP_EEXIST` naming the directory it had just created. The staged tree
  is now copied into the claimed directory one entry at a time, so every copy
  lands on a new path on every Node version and a pre-existing entry is still
  refused rather than overwritten.
