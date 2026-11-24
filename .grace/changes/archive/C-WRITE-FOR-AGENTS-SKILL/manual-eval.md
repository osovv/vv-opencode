# Manual evaluation — C-WRITE-FOR-AGENTS-SKILL

Bounded manual evaluation performed at change time by the implementing agent following the shipped skill instructions, on synthetic inputs. It is evidence that the instructions apply to the intended task shapes. It is neither a CI gate nor proof of general model behavior.

## Task 1 — compilation of a raw mixed request

Input: "Посмотри и вникни в конфиги деплоя, хочу понять всё ли нормально, но в terraform не лезь и не пиши простыню, коротко."

Output (conflicts scoped, not deleted; ambiguity policy applied):

```xml
<task>
  <task_type>investigate</task_type>
  <execution_mode>investigate_first</execution_mode>
  <context>Deployment configuration files are the subject.</context>
  <deliverables>
    <deliverable_1>A findings report on deployment-config correctness.</deliverable_1>
  </deliverables>
  <constraints>
    <constraint_1>Return at most five findings, each under five lines.</constraint_1>
  </constraints>
  <non_goals>
    <non_goal_1>No Terraform files are read or changed.</non_goal_1>
  </non_goals>
  <current_unknowns>
    <unknown_1>Which correctness criteria matter most to the requester.</unknown_1>
  </current_unknowns>
</task>
```

Check: "вникни" + "коротко" became a comprehensive analysis with a bounded report (conflict scoped); the non-goal names the likely drift; the unknown is externalized rather than guessed; empty containers omitted.

## Task 2 — mid-session requirement change

Input: "Теперь не отдельный файл на каждый сервис, а один общий конфиг; лимиты и всё остальное — как раньше."

Output:

```xml
<UPDATE-TURN-18>
  <supersedes>
    <previous>REQUIREMENT-05</previous>
    <replacement id="REQUIREMENT-05">Configuration is emitted into one shared config file.</replacement>
  </supersedes>
  <preserves>REQUIREMENT-01, REQUIREMENT-02, REQUIREMENT-03</preserves>
  <current-task>Re-emit the three services into the shared config; keep rate limits unchanged.</current-task>
</UPDATE-TURN-18>
```

Check: the change is expressed as supersedes with the replaced ID, surviving rules are named through preserves, the current task is restated explicitly, and history is not silently rewritten.

## Task 3 — enhancer schema reuse

Input: "Проверь, что в README все команды реально работают."

Output reuses the enhancer schema exactly — task_type `review`, execution_mode `investigate_first`, containers `context` / `deliverables` / `acceptance_criteria` / `verification`, unique child tags (`<criterion_1>`, `<check_1>`) — with no invented fields, no repeated generic tags, and empty sections omitted. The boundary rule held: the schema was reused, not forked.

## Verdict

All three tasks behaved as the spec's AC-17 requires: conflicts scoped, updates carried IDs, and the emitted XML reused the enhancer schema.
