/**
 * Words people say all the time in meetings. As an agent's wake word, each would wake it
 * constantly ("Can you…", "Mark that down"), so they're refused.
 */
export const COMMON_WORDS: ReadonlySet<string> = new Set(
  `a about above after again against ago all almost along already also although always am an and
   another any anybody anyone anything anyway anywhere are around as ask asked at away back bad be
   because been before being below best better between big bit both bring but buy by call called
   came can cannot case change check clear close come coming could day days did do does doing done
   down during each early easy either else end enough even ever every everything fact far few find
   fine first for found from full further get gets getting give given go goes going gone good got
   great had half happen has have having he hear help her here hers high him his hold how however
   idea if important in into is issue it its itself job just keep kind know last late later least
   leave left less let like likely little long look looking lot lots made make makes making many
   mark may maybe mean means might mine minute minutes more most move much must my myself name near
   need needs never new next nice night no none nor not note notes nothing now number of off often
   oh old on once one only open or order other others our out over own part people perhaps place
   plan play point put question quick quite rather ready real really right said same saw say says
   see seem seems seen set shall she should show side since small so some something sometimes soon
   sorry sort start still stop such sure take talk tell than thank thanks that the their them then
   there these they thing things think this those though thought through time times to today
   together told too took top toward try trying turn two under until up upon us use used very
   wait want wanted was watch way we week well went were what when where whether which while who
   whole whom whose why will wish with within without wonder word words work working would wrong
   year yes yet you your yours`.split(/\s+/),
);
