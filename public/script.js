document.addEventListener('DOMContentLoaded', () => {
    let questions = [];
    let currentStep = 0;
    let responses = {};
    let finalPayload = {
        answer: null, // For backward compatibility with simpler UI
        note: null,
        serviceNote: null,
        responses: {}
    };

    // DOM Elements
    const questionStep = document.getElementById('questionStep');
    const questionText = document.getElementById('questionText');
    const yesNoButtons = document.getElementById('yesNoButtons');
    const yesBtn = document.getElementById('yesBtn');
    const noBtn = document.getElementById('noBtn');

    const noteContainer = document.getElementById('noteContainer');
    const notePrompt = document.getElementById('notePrompt');
    const noteInput = document.getElementById('noteInput');
    const submitNoteBtn = document.getElementById('submitNoteBtn');

    const resultContainer = document.getElementById('resultContainer');
    const answerText = document.getElementById('answerText');
    const couponContainer = document.getElementById('couponContainer');
    const couponCode = document.getElementById('couponCode');
    const card = document.querySelector('.card.glass');

    const welcomeScreen = document.getElementById('welcomeScreen');
    const mainApp = document.getElementById('mainApp');

    // Clicking anywhere on welcome screen starts the app
    welcomeScreen.addEventListener('click', () => {
        welcomeScreen.classList.add('hidden');
        mainApp.classList.remove('hidden');
        if (questions.length > 0) {
            renderQuestion();
        }
    });

    // Load questions on start (but don't render yet)
    fetch('/api/questions')
        .then(res => res.json())
        .then(data => {
            questions = data;
            // Removed automatic renderQuestion call
        })
        .catch(err => {
            console.error('Failed to load questions:', err);
            questionText.innerText = "Chyba při načítání.";
        });

    function renderQuestion() {
        const q = questions[currentStep];
        questionText.classList.remove('hidden');
        questionText.innerText = q.text;
        yesNoButtons.classList.remove('hidden');
        noteContainer.classList.add('hidden');
        noteInput.value = '';
    }

    yesBtn.addEventListener('click', () => handleChoice('ANO'));
    noBtn.addEventListener('click', () => handleChoice('NE'));

    function handleChoice(choice) {
        const q = questions[currentStep];
        responses[q.id] = { answer: choice, note: "" };

        // Backward compatibility mapping for first two questions
        if (currentStep === 0) finalPayload.answer = choice;

        if (q.allowNote) {
            showNoteInput(choice);
        } else {
            nextStep();
        }
    }

    function showNoteInput(choice) {
        const q = questions[currentStep];
        yesNoButtons.classList.add('hidden');
        noteContainer.classList.remove('hidden');
        notePrompt.innerText = choice === 'ANO' ?
            (q.yesPrompt || "Máte pro nás nějaký postřeh? ✨") :
            (q.noPrompt || "Mrzí nás to. 😔 Chcete nám říct proč?");

        noteInput.placeholder = q.placeholder || "Vaše zpráva... (nepovinné)";
    }

    submitNoteBtn.addEventListener('click', () => {
        const q = questions[currentStep];
        const note = noteInput.value.trim();
        responses[q.id].note = note;

        // Backward compatibility mapping
        if (currentStep === 0) finalPayload.note = note;
        if (currentStep === 1) finalPayload.serviceNote = note;

        nextStep();
    });

    function nextStep() {
        currentStep++;
        if (currentStep < questions.length) {
            renderQuestion();
        } else {
            submitAll();
        }
    }

    function submitAll() {
        questionStep.classList.add('hidden');
        finalPayload.responses = responses;

        fetch('/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(finalPayload)
        })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    showThankYou(data.couponCode, data.couponValue);
                } else {
                    alert('Chyba při odesílání.');
                    location.reload();
                }
            })
            .catch(err => {
                console.error(err);
                alert('Chyba při odesílání.');
                location.reload();
            });
    }

    function showThankYou(code, val) {
        card.classList.add('compact');
        resultContainer.classList.remove('hidden');
        resultContainer.classList.add('show');

        let timeout = 5000; // Default 5s

        if (code) {
            const label = document.getElementById('couponValueLabel');
            couponCode.innerText = code;
            if (val) label.innerText = val + ":";
            couponContainer.classList.remove('hidden');
            timeout = 10000; // Keep longer if they need to screenshot (10s is still better than nothing, but let's make it 7s as requested "faster")
            timeout = 8000;
        } else {
            timeout = 4000; // Faster if just saying thank you
        }

        setTimeout(() => {
            location.reload();
        }, timeout);
    }
});
