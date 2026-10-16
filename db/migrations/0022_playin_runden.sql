-- Play-In Worlds 2026: Das Spiel um 20:00 ist das Upper Bracket Final (Sieger der ersten Runde),
-- das um 01:00 das Lower Bracket Semifinal (Verlierer). Die Phasen der beiden Spiele waren vertauscht.
-- Läuft nur, solange sie noch vertauscht sind; ohne dieses Turnier passiert nichts.
update matches m
   set stage_id = (select s2.id from stages s2
                    where s2.tournament_id = m.tournament_id
                      and s2.name = case m.external_id when 'pi-uh' then 'Play-In: oberes Finale' else 'Play-In: unteres Halbfinale' end)
 where m.external_id in ('pi-uh', 'pi-of')
   and m.tournament_id in (select id from tournaments where external_id = 'worlds-2026')
   and exists (select 1 from matches p join stages ps on ps.id = p.stage_id
                where p.tournament_id = m.tournament_id and p.external_id = 'pi-uh' and ps.name = 'Play-In: unteres Halbfinale')
   and exists (select 1 from stages s3 where s3.tournament_id = m.tournament_id and s3.name = 'Play-In: oberes Finale')
   and exists (select 1 from stages s4 where s4.tournament_id = m.tournament_id and s4.name = 'Play-In: unteres Halbfinale');
