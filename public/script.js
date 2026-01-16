document.addEventListener('DOMContentLoaded', () => {
    // State to hold feedback data
    let currentFeedback = {
        answer: null,
        note: null,
        serviceNote: null
    };

    // DOM Elements
    const yesBtn = document.getElementById('yesBtn');
    const noBtn = document.getElementById('noBtn');
    const followUpContainer = document.getElementById('followUpContainer');
    const reasonYesBtn = document.getElementById('reasonYesBtn');
    const reasonNoBtn = document.getElementById('reasonNoBtn');
    const reasonInputContainer = document.getElementById('reasonInputContainer');
    const reasonText = document.getElementById('reasonText');
    const submitReasonBtn = document.getElementById('submitReasonBtn');

    // New DOM Elements
    const serviceQuestionContainer = document.getElementById('serviceQuestionContainer');
    const serviceYesBtn = document.getElementById('serviceYesBtn');
    const serviceNoBtn = document.getElementById('serviceNoBtn');
    const serviceInputContainer = document.getElementById('serviceInputContainer');
    const serviceText = document.getElementById('serviceText');
    const submitServiceBtn = document.getElementById('submitServiceBtn');

    const resultContainer = document.getElementById('resultContainer');
    const answerText = document.getElementById('answerText');
    const couponContainer = document.getElementById('couponContainer');
    const couponCode = document.getElementById('couponCode');
    const card = document.querySelector('.card.glass');

    // --- Step 1: Coffee Question ---
    yesBtn.addEventListener('click', () => {
        currentFeedback = { answer: 'ANO', note: null, serviceNote: null }; // Reset state
        hideMainButtons();
        showServiceQuestion(); // Skip reason, go to Service
    });

    noBtn.addEventListener('click', () => {
        currentFeedback = { answer: 'NE', note: null, serviceNote: null }; // Reset state
        hideMainButtons();
        followUpContainer.classList.remove('hidden'); // Show Reason Question
    });

    // --- Step 2: Reason Question (if Coffee was NE) ---
    reasonYesBtn.addEventListener('click', () => {
        followUpContainer.classList.add('hidden');
        reasonInputContainer.classList.remove('hidden');
    });

    reasonNoBtn.addEventListener('click', () => {
        followUpContainer.classList.add('hidden');
        submitFeedback(); // End flow with thank you message
    });

    submitReasonBtn.addEventListener('click', () => {
        const note = reasonText.value.trim();
        if (note) {
            currentFeedback.note = note;
        }
        reasonInputContainer.classList.add('hidden');
        showServiceQuestion(); // Go to Service
    });

    // --- Step 3: Service Question ---
    function showServiceQuestion() {
        serviceQuestionContainer.classList.remove('hidden');
    }

    serviceYesBtn.addEventListener('click', () => {
        serviceQuestionContainer.classList.add('hidden');
        serviceInputContainer.classList.remove('hidden');
    });

    serviceNoBtn.addEventListener('click', () => {
        // User doesn't want to rate service -> SUBMIT ALL
        serviceQuestionContainer.classList.add('hidden');
        submitFeedback();
    });

    submitServiceBtn.addEventListener('click', () => {
        const note = serviceText.value.trim();
        if (note) {
            currentFeedback.serviceNote = note;
        }
        serviceInputContainer.classList.add('hidden');
        submitFeedback();
    });

    // --- Helper to Hide Main Buttons ---
    function hideMainButtons() {
        yesBtn.parentElement.classList.add('hidden');
        document.querySelector('h1').classList.add('hidden');
    }

    // --- Final Submission ---
    function submitFeedback() {
        fetch('/api/feedback', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(currentFeedback),
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    showThankYou(data.couponCode, data.couponValue);
                } else {
                    alert('Chyba při odesílání.');
                    resetApp();
                }
            })
            .catch((error) => {
                console.error('Error:', error);
                alert('Chyba při odesílání.');
                resetApp();
            });
    }

    function showThankYou(serverCouponCode, serverCouponValue) {
        card.classList.add('compact');
        resultContainer.classList.remove('hidden');
        resultContainer.classList.add('show');
        answerText.innerText = "Děkujeme za zpětnou vazbu a hezký den";

        // Display coupon if provided by server
        if (serverCouponCode) {
            const couponValueLabel = document.getElementById('couponValueLabel');
            couponCode.innerText = serverCouponCode;
            if (serverCouponValue) {
                couponValueLabel.innerText = serverCouponValue + ":";
            }
            couponContainer.classList.remove('hidden');
        } else {
            couponContainer.classList.add('hidden');
        }

        setTimeout(() => {
            resetApp();
        }, 5000);
    }

    function resetApp() {
        // Reset UI
        card.classList.remove('compact');
        resultContainer.classList.remove('show');
        resultContainer.classList.add('hidden');
        couponContainer.classList.add('hidden');
        followUpContainer.classList.add('hidden');
        reasonInputContainer.classList.add('hidden');
        serviceQuestionContainer.classList.add('hidden');
        serviceInputContainer.classList.add('hidden');

        // Clear Inputs
        reasonText.value = '';
        serviceText.value = '';

        // Show Main
        yesBtn.parentElement.classList.remove('hidden');
        document.querySelector('h1').classList.remove('hidden');
    }
});
