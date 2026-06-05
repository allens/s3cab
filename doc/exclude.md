The syntax for the exclude file:

## Globbing

The path _separator_ is always the `/` character.
A _segment_ is everything that comes between the two separators.

Single asterix `*` matches one or more characters within one segment.

Double asterix `**` matches zero or more characters across multiple segments. No other chact

Example: `Test/**/*.js` will be restricted to the `Tests` directory. The glob will macth the files such as `Tests/HelloWorld.js`, `Tests/UI/HelloWorld.js`, `Tests/UI/Feature1/HelloWorld.js`

Example: `**/log.txt` will match a file named `log.txt` in any directory, including the root. The glob will match `log.txt`, `Tests/log.txt` and `Tests/UI/log.txt`
