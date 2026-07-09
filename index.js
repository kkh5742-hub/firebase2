import { firebaseConfig } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
  getFirestore, doc, getDoc, setDoc, increment, serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { 
  getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// 설문조사 정의 정의
const SURVEY = {
  id: "survey-1",
  title: "교육 만족도 설문",
  questions: [
    { id: "q1", type: "choice", text: "전반적으로 만족하셨나요?",
      options: ["매우 불만족", "불만족", "보통", "만족", "매우 만족"] },
    { id: "q2", type: "text", text: "개선했으면 하는 점을 적어주세요.", maxLength: 500 }
  ]
};

// Global variables provided by ecosystem or fallback
const appId = typeof __app_id !== 'undefined' ? __app_id : 'jeju-artifact';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// DOM Elements
const questionsContainer = document.getElementById("questions-container");
const surveyForm = document.getElementById("survey-form");
const submitBtn = document.getElementById("submit-btn");
const errorBox = document.getElementById("error-box");
const surveyScreen = document.getElementById("survey-screen");
const successScreen = document.getElementById("success-screen");
const surveyTitleEl = document.getElementById("survey-title");

let currentUser = null;
let respondentId = "";

// 1. 응답자 ID 취득/생성
function getOrCreateRespondentId() {
  let id = localStorage.getItem("survey_respondent_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("survey_respondent_id", id);
  }
  return id;
}

respondentId = getOrCreateRespondentId();

// UI 에러 노출용 공통 헬퍼
function showError(message) {
  errorBox.textContent = message;
  errorBox.style.display = "block";
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function handleFirebaseError(error) {
  if (error.code === 'permission-denied') {
    showError("Firestore 보안 규칙이 적용되지 않았습니다. 배포 가이드 3단계를 확인하세요.");
  } else {
    showError(`오류가 발생했습니다: ${error.message || error}`);
  }
}

// 2. SURVEY 정의에 따라 질문 폼 렌더링
function renderQuestions() {
  surveyTitleEl.textContent = SURVEY.title;
  questionsContainer.innerHTML = "";

  SURVEY.questions.forEach((q) => {
    const card = document.createElement("div");
    card.className = "question-card";
    card.setAttribute("data-q-id", q.id);

    const qText = document.createElement("div");
    qText.className = "question-text";
    qText.textContent = q.text;
    card.appendChild(qText);

    if (q.type === "choice") {
      const optionsGroup = document.createElement("div");
      optionsGroup.className = "options-group";

      q.options.forEach((opt) => {
        const label = document.createElement("label");
        label.className = "option-label";

        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = q.id;
        radio.value = opt;

        label.appendChild(radio);
        label.appendChild(document.createTextNode(opt));
        optionsGroup.appendChild(label);
      });
      card.appendChild(optionsGroup);

    } else if (q.type === "text") {
      const textGroup = document.createElement("div");
      textGroup.className = "text-input-group";

      const textarea = document.createElement("textarea");
      textarea.name = q.id;
      textarea.maxLength = q.maxLength;
      textarea.placeholder = "의견을 작성해 주세요. (선택사항)";

      const counter = document.createElement("div");
      counter.className = "char-counter";
      counter.textContent = `0 / ${q.maxLength}`;

      textarea.addEventListener("input", () => {
        counter.textContent = `${textarea.value.length} / ${q.maxLength}`;
      });

      textGroup.appendChild(textarea);
      textGroup.appendChild(counter);
      card.appendChild(textGroup);
    }

    // 에러 메세지 슬롯 추가
    const errEl = document.createElement("div");
    errEl.className = "validation-error";
    errEl.id = `error-${q.id}`;
    errEl.textContent = "필수 입력 항목입니다.";
    card.appendChild(errEl);

    questionsContainer.appendChild(card);
  });
}

// 초기화 과정
async function initAuthAndApp() {
  submitBtn.disabled = true;
  try {
    // Rule 3: Auth Before Queries - Custom token or Anonymous authentication
    if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
      await signInWithCustomToken(auth, __initial_auth_token);
    } else {
      await signInAnonymously(auth);
    }
  } catch (error) {
    handleFirebaseError(error);
  }
}

// 인증 변경 감지 리스너
onAuthStateChanged(auth, (user) => {
  if (user) {
    currentUser = user;
    submitBtn.disabled = false;
  } else {
    currentUser = null;
    submitBtn.disabled = true;
  }
});

// 폼 유효성 검사 및 데이터 가공
function validateAndGetAnswers() {
  let isValid = true;
  const answers = {};

  SURVEY.questions.forEach((q) => {
    const errorEl = document.getElementById(`error-${q.id}`);
    errorEl.style.display = "none";

    if (q.type === "choice") {
      const selectedRadio = surveyForm.querySelector(`input[name="${q.id}"]:checked`);
      if (!selectedRadio) {
        errorEl.style.display = "block";
        isValid = false;
      } else {
        answers[q.id] = selectedRadio.value;
      }
    } else if (q.type === "text") {
      const textarea = surveyForm.querySelector(`textarea[name="${q.id}"]`);
      answers[q.id] = textarea.value.trim();
    }
  });

  return isValid ? answers : null;
}

// 폼 서브밋 이벤트 핸들링
surveyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUser) return;

  errorBox.style.display = "none";

  const answers = validateAndGetAnswers();
  if (!answers) return; // 유효성 검사 통과 실패 시 중단

  submitBtn.disabled = true;

  try {
    // Rule 1: Strict Paths 적용
    // 개별 응답 문서 레퍼런스
    const responseDocRef = doc(
      db, 
      'artifacts', appId, 
      'public', 'data', 
      'surveys', SURVEY.id, 
      'responses', respondentId
    );

    // 실시간 통계 요약 문서 레퍼런스
    const summaryDocRef = doc(
      db, 
      'artifacts', appId, 
      'public', 'data', 
      'surveys', SURVEY.id, 
      'results', 'summary'
    );

    // 4. 이전 제출 여부 확인 (getDoc)
    const responseSnap = await getDoc(responseDocRef);
    const isResubmission = responseSnap.exists();
    const oldAnswers = isResubmission ? (responseSnap.data().answers || {}) : {};

    // 5. responses/{응답자ID}에 덮어쓰기 저장
    await setDoc(responseDocRef, {
      answers: answers,
      submittedAt: serverTimestamp()
    });

    // 6. results/summary 문서에 집계 증감 데이터 계산
    const summaryUpdate = {};

    if (!isResubmission) {
      // 신규 등록: 응답수 +1, 각 객관식 답변 +1
      summaryUpdate.responseCount = increment(1);

      SURVEY.questions.forEach((q) => {
        if (q.type === "choice") {
          const ansVal = answers[q.id];
          if (ansVal) {
            summaryUpdate[`counts.${q.id}.${ansVal}`] = increment(1);
          }
        }
      });
    } else {
      // 재제출: 이전 선택 -1, 새 선택 +1 (전체 응답 수는 유지)
      let changeDetected = false;

      SURVEY.questions.forEach((q) => {
        if (q.type === "choice") {
          const oldAns = oldAnswers[q.id];
          const newAns = answers[q.id];

          if (oldAns !== newAns) {
            changeDetected = true;
            if (oldAns) {
              summaryUpdate[`counts.${q.id}.${oldAns}`] = increment(-1);
            }
            if (newAns) {
              summaryUpdate[`counts.${q.id}.${newAns}`] = increment(1);
            }
          }
        }
      });

      // 만약 재제출 시 변경된 문항이 없다면 increment를 실행할 필요 없음
      if (!changeDetected) {
        // 성공 화면으로 전환
        surveyScreen.classList.add("hidden");
        successScreen.classList.remove("hidden");
        return;
      }
    }

    // 결과 요약 문서에 트랜잭션 수치 업데이트
    await setDoc(summaryDocRef, summaryUpdate, { merge: true });

    // 7. 성공 화면 갱신
    surveyScreen.classList.add("hidden");
    successScreen.classList.remove("hidden");

  } catch (error) {
    handleFirebaseError(error);
    submitBtn.disabled = false;
  }
});

// App 시작
renderQuestions();
initAuthAndApp();
