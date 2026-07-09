import { firebaseConfig } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
  getFirestore, doc, onSnapshot, collection, query, orderBy, limit 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { 
  getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// 설문조사 구조 정의
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
const totalCountEl = document.getElementById("total-count");
const chartsContainer = document.getElementById("charts-container");
const feedbackListEl = document.getElementById("feedback-list");
const errorBox = document.getElementById("error-box");
const resultsTitleEl = document.getElementById("results-title");

let summaryUnsubscribe = null;
let textAnswersUnsubscribe = null;

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

// 1. 객관식 데이터 렌더링 (CSS 수평 막대로 표시)
function updateChoiceCharts(counts, totalCount) {
  chartsContainer.innerHTML = "";
  
  SURVEY.questions.forEach((q) => {
    if (q.type !== "choice") return;

    const groupDiv = document.createElement("div");
    groupDiv.className = "question-card";

    const qText = document.createElement("div");
    qText.className = "question-text";
    qText.textContent = q.text;
    groupDiv.appendChild(qText);

    // 각 옵션별 수치 시각화
    q.options.forEach((opt) => {
      const voteCount = (counts[q.id] && counts[q.id][opt]) ? counts[q.id][opt] : 0;
      
      // 마이너스 값 보정 및 백분율 계산
      const validVoteCount = Math.max(0, voteCount);
      const percentage = totalCount > 0 ? Math.round((validVoteCount / totalCount) * 100) : 0;

      const chartItem = document.createElement("div");
      chartItem.className = "chart-item";

      const labelRow = document.createElement("div");
      labelRow.className = "chart-label-row";
      
      const labelText = document.createElement("span");
      labelText.textContent = opt;
      
      const statText = document.createElement("span");
      statText.textContent = `${validVoteCount}명 (${percentage}%)`;
      
      labelRow.appendChild(labelText);
      labelRow.appendChild(statText);

      const barContainer = document.createElement("div");
      barContainer.className = "bar-container";

      const barFill = document.createElement("div");
      barFill.className = "bar-fill";
      
      // DOM 생성 후 브라우저 렌더링 루프를 거쳐 애니메이션 효과를 구현하기 위해 setTimeout 사용
      setTimeout(() => {
        barFill.style.width = `${percentage}%`;
      }, 50);

      barContainer.appendChild(barFill);
      chartItem.appendChild(labelRow);
      chartItem.appendChild(barContainer);
      groupDiv.appendChild(chartItem);
    });

    chartsContainer.appendChild(groupDiv);
  });
}

// 2. 주관식 데이터 피드백 렌더링 (최근 20개 리스팅)
function updateTextAnswers(docs) {
  feedbackListEl.innerHTML = "";
  
  const textQuestion = SURVEY.questions.find(q => q.type === "text");
  if (!textQuestion) return;

  const feedbacks = [];

  docs.forEach((docSnap) => {
    const data = docSnap.data();
    const textVal = data.answers ? data.answers[textQuestion.id] : "";
    
    if (textVal && textVal.trim() !== "") {
      const time = data.submittedAt ? new Date(data.submittedAt.seconds * 1000).toLocaleString() : "방금 전";
      feedbacks.push({ text: textVal, time: time });
    }
  });

  if (feedbacks.length === 0) {
    feedbackListEl.innerHTML = `<div style="color: #64748b; text-align: center; padding: 20px 0;">등록된 개선 의견이 아직 없습니다.</div>`;
    return;
  }

  feedbacks.forEach((fb) => {
    const card = document.createElement("div");
    card.className = "feedback-card";

    const textContent = document.createElement("div");
    textContent.textContent = fb.text; // textContent로 XSS 방지 안전성 확보

    const timeContent = document.createElement("div");
    timeContent.className = "feedback-time";
    timeContent.textContent = fb.time;

    card.appendChild(textContent);
    card.appendChild(timeContent);
    feedbackListEl.appendChild(card);
  });
}

// Real-time Firestore 리스너 시작
function startListening() {
  if (!auth.currentUser) return;

  // 1. results/summary 단일 문서 실시간 모니터링 (onSnapshot)
  const summaryDocRef = doc(
    db, 
    'artifacts', appId, 
    'public', 'data', 
    'surveys', SURVEY.id, 
    'results', 'summary'
  );

  summaryUnsubscribe = onSnapshot(summaryDocRef, (docSnap) => {
    let responseCount = 0;
    let counts = {};

    if (docSnap.exists()) {
      const data = docSnap.data();
      responseCount = data.responseCount || 0;
      counts = data.counts || {};
    }

    // 최상단 총 응답자수 표기 변경
    totalCountEl.textContent = responseCount;
    // 그래프 컴포넌트 갱신
    updateChoiceCharts(counts, responseCount);
  }, (error) => {
    handleFirebaseError(error);
  });

  // 2. responses 최근 20개 조회 리스너
  const responsesColRef = collection(
    db, 
    'artifacts', appId, 
    'public', 'data', 
    'surveys', SURVEY.id, 
    'responses'
  );

  const textQuery = query(
    responsesColRef, 
    orderBy("submittedAt", "desc"), 
    limit(20)
  );

  textAnswersUnsubscribe = onSnapshot(textQuery, (querySnap) => {
    updateTextAnswers(querySnap.docs);
  }, (error) => {
    handleFirebaseError(error);
  });
}

// 초기화 시작
async function initAuthAndApp() {
  resultsTitleEl.textContent = `${SURVEY.title} 결과`;
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

// 인증 완료 시 리스너 구독 시작 및 해제 처리
onAuthStateChanged(auth, (user) => {
  if (user) {
    startListening();
  } else {
    if (summaryUnsubscribe) summaryUnsubscribe();
    if (textAnswersUnsubscribe) textAnswersUnsubscribe();
  }
});

initAuthAndApp();