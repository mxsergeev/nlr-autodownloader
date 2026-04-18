# Agent Instructions

## Code quality

Before completing any task, run the linter and formatter for every file you modified:

- **Server code changed**

  ```sh
  cd server && npm run lint:fix && npm run format
  ```

- **Frontend code changed**

  ```sh
  cd frontend && npm run lint:fix && npm run format
  ```

- **Both changed** — run both commands above.

Fix any errors reported by the linter before finishing. Warnings are acceptable but should be minimised.

## Git

**Never run `git commit`, `git push`, `git add`, or any other git write command.**

Always leave commits for the human to review and create manually.
