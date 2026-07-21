import json

questions = [
    {"num": 1, "text": "Hello. I ______ from Italy.", "opts": ["am", "is", "are", "be"], "ans": "am"},
    {"num": 2, "text": "My sister ______ to music every evening.", "opts": ["listen", "listens", "listening", "is listen"], "ans": "listens"},
    {"num": 3, "text": "______ they like tea or coffee?", "opts": ["Are", "Does", "Do", "Is"], "ans": "Do"},
    {"num": 4, "text": "We don't have ______ milk in the fridge.", "opts": ["some", "any", "a", "no"], "ans": "any"},
    {"num": 5, "text": "Excuse me, where is ______ nearest bank?", "opts": ["a", "an", "the", "no article"], "ans": "the"},
    {"num": 6, "text": "I am reading a great book ______ the moment.", "opts": ["in", "on", "at", "by"], "ans": "at"},
    {"num": 7, "text": "Yesterday, we ______ to a great restaurant.", "opts": ["go", "going", "went", "gone"], "ans": "went"},
    {"num": 8, "text": "Were you at home last night? No, I ______.", "opts": ["wasn't", "weren't", "didn't", "am not"], "ans": "wasn't"},
    {"num": 9, "text": "She is ______ than her brother.", "opts": ["tall", "more tall", "taller", "the tallest"], "ans": "taller"},
    {"num": 10, "text": "How ______ apples do we need for the pie?", "opts": ["much", "many", "lot", "any"], "ans": "many"},
    {"num": 11, "text": "You ______ wear a seatbelt when driving. It's the law.", "opts": ["can", "might", "must", "would"], "ans": "must"},
    {"num": 12, "text": "Look at those dark clouds! It ______ rain.", "opts": ["is going to", "will", "raining", "rains"], "ans": "is going to"},
    {"num": 13, "text": "I ______ this car for three years.", "opts": ["have", "having", "have had", "had"], "ans": "have had"},
    {"num": 14, "text": "If you study hard, you ______ the exam.", "opts": ["pass", "passed", "will pass", "would pass"], "ans": "will pass"},
    {"num": 15, "text": "I really enjoy ______ tennis on the weekends.", "opts": ["play", "to play", "played", "playing"], "ans": "playing"},
    {"num": 16, "text": "While I ______ to work, I saw an accident.", "opts": ["drive", "was driving", "am driving", "driven"], "ans": "was driving"},
    {"num": 17, "text": "The man ______ stole my bag was wearing a red hat.", "opts": ["which", "where", "who", "whose"], "ans": "who"},
    {"num": 18, "text": "Many new houses ______ in our town every year.", "opts": ["build", "are built", "is building", "are building"], "ans": "are built"},
    {"num": 19, "text": "We don't have enough time. We need to ______ up.", "opts": ["make", "get", "hurry", "turn"], "ans": "hurry"},
    {"num": 20, "text": "If I ______ you, I would look for a new job.", "opts": ["am", "was", "were", "have been"], "ans": "were"},
    {"num": 21, "text": "She asked me what time ______.", "opts": ["was it", "it was", "is it", "it is"], "ans": "it was"},
    {"num": 22, "text": "By this time next year, I ______ my English course.", "opts": ["finish", "will finish", "will have finished", "am finishing"], "ans": "will have finished"},
    {"num": 23, "text": "I'm not used to ______ up so early.", "opts": ["wake", "waking", "woke", "woken"], "ans": "waking"},
    {"num": 24, "text": "You ______ have seen John yesterday; he is in Tokyo!", "opts": ["mustn't", "couldn't", "shouldn't", "wouldn't"], "ans": "couldn't"},
    {"num": 25, "text": "Despite ______ tired, she finished the report.", "opts": ["to be", "she was", "being", "of being"], "ans": "being"},
    {"num": 26, "text": "He had his car ______ by a professional mechanic.", "opts": ["to repair", "repairing", "repaired", "repair"], "ans": "repaired"}
]

html_out = '<div style="display:flex; flex-direction:column; gap:20px; font-family: \'Nunito\', sans-serif;">\n'
html_out += '<h3 style="color:var(--z-blue); border-bottom:2px solid var(--z-blue-light); padding-bottom:10px;">SECTION 1: GRAMMAR & LANGUAGE USE</h3>\n'

for q in questions:
    opts_html = "".join([f'<option value="{o}">{o}</option>' for o in q["opts"]])
    select_html = f'<select class="interactive-select" data-answer="{q["ans"]}"><option value=""></option>{opts_html}</select>'
    
    q_text = q["text"].replace("______", select_html)
    
    html_out += f'  <div style="background:#fff; padding:15px 20px; border-radius:12px; border:1px solid var(--line); box-shadow:0 4px 10px rgba(0,0,0,0.03); font-size:1.1rem;">\n'
    html_out += f'    <strong>{q["num"]}.</strong> {q_text}\n'
    html_out += '  </div>\n'

readings = [
    {
        "title": "Text 1: A Message to a Colleague",
        "text": "<strong>Subject: Meeting Tomorrow</strong><br><br>Hi David,<br>I am writing about our meeting tomorrow. I cannot come to the office at 9:00 AM because I have a doctor's appointment. Can we meet at 11:30 AM instead? We can go to the café next to the office and talk about the new project. Let me know if this time is okay for you.<br>Best,<br>Sarah",
        "qs": [
            {"num": 27, "text": "Why can't Sarah meet at 9:00 AM?", "opts": ["She is sick.", "She has a doctor's appointment.", "She is late for work."], "ans": "She has a doctor's appointment."},
            {"num": 28, "text": "Where does Sarah want to meet?", "opts": ["In the office.", "At the doctor's.", "In a café."], "ans": "In a café."},
            {"num": 29, "text": "What is the main purpose of this email?", "opts": ["To change a meeting time.", "To invite David to lunch.", "To complain about a project."], "ans": "To change a meeting time."}
        ]
    },
    {
        "title": "Text 2: Travel and Technology",
        "text": "Traveling has changed significantly in the last ten years. In the past, people relied on paper maps and travel agents to plan their holidays. Today, a smartphone is the only tool you need. You can book flights, find hotels, and translate languages with a few taps. However, some travelers feel that this constant connection to technology ruins the adventure. They argue that getting lost and asking locals for directions is the best way to discover a new city.",
        "qs": [
            {"num": 30, "text": "How did people mainly plan holidays in the past?", "opts": ["Using smartphones.", "Using paper maps and agents.", "Asking locals."], "ans": "Using paper maps and agents."},
            {"num": 31, "text": "What is one disadvantage of using technology while traveling, according to the text?", "opts": ["It is too expensive.", "It makes booking flights harder.", "It might ruin the sense of adventure."], "ans": "It might ruin the sense of adventure."},
            {"num": 32, "text": "What does the word 'relied' mean in this context?", "opts": ["Depended", "Ignored", "Discovered"], "ans": "Depended"}
        ]
    },
    {
        "title": "Text 3: Workplace Communication",
        "text": "In today's fast-paced corporate environment, effective communication is more critical than ever. While emails are excellent for keeping records, they can often lead to misunderstandings because they lack tone of voice and body language. For urgent issues or complex problem-solving, a quick phone call or a brief face-to-face meeting is usually far more efficient. Companies are now encouraging employees to choose the right medium for their message to avoid unnecessary delays and workplace frustration.",
        "qs": [
            {"num": 33, "text": "Why can emails sometimes cause misunderstandings?", "opts": ["They are too fast.", "They lack tone of voice.", "They don't keep records."], "ans": "They lack tone of voice."},
            {"num": 34, "text": "What does the text suggest for complex problem-solving?", "opts": ["Writing a long email.", "A phone call or face-to-face meeting.", "Sending a text message."], "ans": "A phone call or face-to-face meeting."},
            {"num": 35, "text": "What is the main idea of this text?", "opts": ["Emails are no longer useful.", "Employees should choose the correct communication method.", "Face-to-face meetings are a waste of time."], "ans": "Employees should choose the correct communication method."}
        ]
    }
]

html_out += '<h3 style="color:var(--z-blue); border-bottom:2px solid var(--z-blue-light); padding-bottom:10px; margin-top:30px;">SECTION 2: READING COMPREHENSION</h3>\n'

for r in readings:
    html_out += f'  <div style="background:#f8fafc; padding:20px; border-radius:12px; border-left:4px solid var(--z-yellow); margin-bottom:20px;">\n'
    html_out += f'    <h4 style="margin-top:0; color:var(--z-yellow-dark);">{r["title"]}</h4>\n'
    html_out += f'    <p style="line-height:1.6;">{r["text"]}</p>\n'
    html_out += '  </div>\n'
    
    for q in r["qs"]:
        opts_html = "".join([f'<option value="{o}">{o}</option>' for o in q["opts"]])
        select_html = f'<select class="interactive-select" style="margin-top:10px; width:100%; text-align:left;" data-answer="{q["ans"]}"><option value=""></option>{opts_html}</select>'
        
        html_out += f'  <div style="background:#fff; padding:15px 20px; border-radius:12px; border:1px solid var(--line); box-shadow:0 4px 10px rgba(0,0,0,0.03); font-size:1.1rem; margin-bottom:15px;">\n'
        html_out += f'    <strong>{q["num"]}.</strong> {q["text"]}<br>\n'
        html_out += f'    {select_html}\n'
        html_out += '  </div>\n'

html_out += '</div>\n'

with open("C:\\Users\\ziyad\\.gemini\\antigravity\\scratch\\Z-English\\test_questions_output.html", "w", encoding="utf-8") as f:
    f.write(html_out)
