-- Live-Kalender-Abo: ein persönlicher, zufälliger Token je Nutzer, mit dem Kalender-Apps den
-- Spielplan selbst regelmäßig neu abrufen können (ohne Login). Der Token wirkt wie der Link
-- selbst als Geheimnis (wie bei Google Kalenders "privater iCal-Adresse"), daher unverschlüsselt
-- gespeichert und direkt als Schlüssel genutzt – anders als Sitzungs-/Reset-Token, die man
-- einmalig eintippt und deren Hash genügt.
alter table users add column calendar_token text unique;
