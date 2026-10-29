# Coding and testing

One prompt per line. Each line is run through the host on its own, against the seed in `seeds/testing.json`, and the eval counts how many runs call a brain tool without being told to. Keep the phrasing of a real task prompt: no mention of Brain, memory, or rules.

- Write a test for the dedupe function in dedupe.ts and make it pass.
- Add coverage for the edge cases in dedupe.ts.
- Write a unit test for the dedupe function.
- This dedupe function fails on NaN. Write a test that catches it and fix it.
- Refactor dedupe.ts so it handles objects too, and keep the tests green.
- Write a test that proves dedupe keeps the first occurrence.
- Make a test for dedupe that would fail if the implementation returned the input untouched.
- Add a test file for dedupe.ts using the project's test setup.
- Code review dedupe.ts and write tests for anything risky you find.
- Write a parametrised test over a table of inputs for dedupe.ts.
- The dedupe function is missing a test for the empty array. Add one.
- Write tests for dedupe.ts and then simplify the implementation without breaking them.
