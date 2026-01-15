import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  SafeAreaView,
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  Switch,
  ScrollView,
  useWindowDimensions,
  Animated,
  Platform
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { WebView } from "react-native-webview";
import * as RNIap from "react-native-iap";

const DEFAULT_WPM = 300;
const MIN_WPM = 60;
const MAX_WPM = 2000;
const FREE_WORD_LIMIT = 10000;
const PRO_WORD_LIMIT = 50000;
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const FREE_LIBRARY_LIMIT = 3;
const AD_FREQUENCY_WORDS = 3000;
const IAP_SKUS = {
  weekly: "reader_pro_weekly",
  monthly: "reader_pro_monthly",
  yearly: "reader_pro_yearly"
};
const FALLBACK_PRICES = {
  weekly: "$2.98",
  monthly: "$8.98",
  yearly: "$29.98"
};
const PDF_CHUNK_SIZE = 500000;
const INITIAL_FULL_TEXT_WORDS = 200;
const FULL_TEXT_WORD_CHUNK = 300;
const FULL_TEXT_CHUNK_DELAY = 120;
const WORDS_PER_PAGE = 200;
const PDF_JS_URL = "https://unpkg.com/pdfjs-dist@3.11.174/legacy/build/pdf.min.js";
const PDF_WORKER_URL =
  "https://unpkg.com/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js";

const extractWords = (text) =>
  text.match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g) ?? [];

const getFocusCharIndex = (word) => {
  if (!word) return 0;
  const index = Math.floor(word.length * 0.4);
  return Math.min(word.length - 1, Math.max(0, index));
};

const splitWordForHighlight = (word) => {
  const focusIndex = getFocusCharIndex(word);
  return {
    before: word.slice(0, focusIndex),
    focus: word.charAt(focusIndex),
    after: word.slice(focusIndex + 1)
  };
};

const clampWpm = (value) => {
  if (Number.isNaN(value)) return DEFAULT_WPM;
  return Math.min(MAX_WPM, Math.max(MIN_WPM, value));
};

const SAMPLE_TEXT =
  "Speed reading makes long passages feel lighter. " +
  "This sample helps you test the one-letter highlight and timing. " +
  "Adjust the WPM, tap play, and see the focus character pop.";

const buildPdfExtractorHtml = (localPdfJsUrl, localWorkerUrl) => `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script>
      (function () {
        const postMessage = (payload) => {
          window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        };

        const loadScript = (url) =>
          new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = url;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
          });

        const ensurePdfJs = async () => {
          if (window.pdfjsLib) return true;
          try {
            if ("${localPdfJsUrl}") {
              await loadScript("${localPdfJsUrl}");
            }
          } catch (error) {
            // fallthrough
          }
          if (!window.pdfjsLib) {
            if ("${PDF_JS_URL}") {
              try {
                await loadScript("${PDF_JS_URL}");
              } catch (error) {
                return false;
              }
            } else {
              return false;
            }
          }
          return !!window.pdfjsLib;
        };

        window.extractPdf = async function (base64, attempt) {
          if (!base64) {
            postMessage({ type: "error", message: "Missing PDF data." });
            return;
          }
          const tries = attempt || 0;
          const ready = await ensurePdfJs();
          if (!ready) {
            if (tries > 3) {
              postMessage({ type: "error", message: "PDF library failed to load." });
              return;
            }
            setTimeout(() => window.extractPdf(base64, tries + 1), 200);
            return;
          }

          // Disable workers in WebView to avoid worker setup errors.
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = null;

          const binary = atob(base64);
          const length = binary.length;
          const bytes = new Uint8Array(length);
          for (let i = 0; i < length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }

          let finished = false;
          const timeoutId = setTimeout(() => {
            if (!finished) {
              finished = true;
              postMessage({ type: "error", message: "PDF extraction timed out." });
            }
          }, 20000);

          window.pdfjsLib
            .getDocument({ data: bytes, disableWorker: true })
            .promise.then(async (pdf) => {
              let fullText = "";
              const pages = [];
              for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
                const page = await pdf.getPage(pageNum);
                const content = await page.getTextContent();
                const pageText = content.items
                  .map((item) => item.str || "")
                  .join(" ");
                pages.push(pageText);
                fullText += pageText + "\\n";
              }
              if (!finished) {
                finished = true;
                clearTimeout(timeoutId);
                postMessage({ type: "success", text: fullText.trim(), pages });
              }
            })
            .catch((error) => {
              if (!finished) {
                finished = true;
                clearTimeout(timeoutId);
                postMessage({ type: "error", message: error.message || "Failed to read PDF." });
              }
            });
        };

        const handleMessage = (event) => {
          try {
            const payload = JSON.parse(event.data || "{}");
            if (payload.type === "pdf-reset") {
              window.__pdfChunks = [];
              window.__pdfChunkTotal = 0;
              return;
            }
            if (payload.type === "pdf") {
              window.extractPdf(payload.base64);
              return;
            }
            if (payload.type === "pdf-chunk") {
              if (!window.__pdfChunks) {
                window.__pdfChunks = [];
              }
              window.__pdfChunkTotal = payload.total || 0;
              window.__pdfChunks[payload.index] = payload.data || "";
              const hasAll =
                window.__pdfChunkTotal > 0 &&
                window.__pdfChunks.filter(Boolean).length === window.__pdfChunkTotal;
              if (hasAll) {
                const joined = window.__pdfChunks.join("");
                window.__pdfChunks = [];
                window.__pdfChunkTotal = 0;
                window.extractPdf(joined);
              }
            }
          } catch (error) {
            postMessage({ type: "error", message: "Invalid PDF message payload." });
          }
        };

        window.addEventListener("message", handleMessage);
        document.addEventListener("message", handleMessage);
        ensurePdfJs().then((ok) => {
          if (ok) {
            postMessage({ type: "ready" });
          } else {
            postMessage({ type: "error", message: "PDF library failed to load." });
          }
        });
      })();
    </script>
  </body>
</html>
`;

export default function App() {
  const [screen, setScreen] = useState("home");
  const [tab, setTab] = useState("home");
  const [isDark, setIsDark] = useState(false);
  const [wpmInput, setWpmInput] = useState(String(DEFAULT_WPM));
  const [wpm, setWpm] = useState(DEFAULT_WPM);
  const [isWpmModalVisible, setIsWpmModalVisible] = useState(false);
  const [readerText, setReaderText] = useState(SAMPLE_TEXT);
  const [pdfText, setPdfText] = useState("");
  const [pdfPages, setPdfPages] = useState([]);
  const [pdfFileName, setPdfFileName] = useState("");
  const [pdfBase64, setPdfBase64] = useState("");
  const [isExtracting, setIsExtracting] = useState(false);
  const [isWebViewReady, setIsWebViewReady] = useState(false);
  const [pdfHtmlUri, setPdfHtmlUri] = useState("");
  const [pdfEngineError, setPdfEngineError] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentWordIndex, setCurrentWordIndex] = useState(0);
  const [wordHeight, setWordHeight] = useState(0);
  const [selectedWordIndex, setSelectedWordIndex] = useState(0);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [readerUiVisible] = useState(true);
  const [isPro, setIsPro] = useState(false);
  const [hasTappedReader, setHasTappedReader] = useState(false);
  const [fullTextCount, setFullTextCount] = useState(INITIAL_FULL_TEXT_WORDS);
  const [fullTextPage, setFullTextPage] = useState(0);
  const lastWordsLengthRef = useRef(0);
  const lastUploadRef = useRef(null);
  const tapHintOpacity = useRef(new Animated.Value(1)).current;
  const [textFooterHeight, setTextFooterHeight] = useState(0);
  const [adBreakActive, setAdBreakActive] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState("yearly");
  const [iapProducts, setIapProducts] = useState({});
  const [iapReady, setIapReady] = useState(false);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  const intervalRef = useRef(null);
  const webViewRef = useRef(null);
  const purchaseUpdateSubRef = useRef(null);
  const purchaseErrorSubRef = useRef(null);
  const pdfReadAccessUri = FileSystem.cacheDirectory;
  const sourceText = pdfText || readerText;
  const maxWords = isPro ? PRO_WORD_LIMIT : FREE_WORD_LIMIT;
  const words = useMemo(() => {
    const allWords = extractWords(sourceText);
    if (allWords.length > maxWords) {
      return allWords.slice(0, maxWords);
    }
    return allWords;
  }, [sourceText, maxWords]);
  const pdfPagesWords = useMemo(
    () => (pdfPages.length ? pdfPages.map((page) => extractWords(page)) : []),
    [pdfPages]
  );
  const pdfPageOffsets = useMemo(() => {
    if (!pdfPagesWords.length) return [];
    let count = 0;
    return pdfPagesWords.map((pageWords) => {
      const offset = count;
      count += pageWords.length;
      return offset;
    });
  }, [pdfPagesWords]);
  const totalWordCount = words.length;

  const theme = useMemo(
    () => ({
      background: isDark ? "#0f1115" : "#ffffff",
      surface: isDark ? "#171a20" : "#f4f5f7",
      text: isDark ? "#f5f6f8" : "#121318",
      subtleText: isDark ? "#9aa0ac" : "#4a4f57",
      border: isDark ? "#232833" : "#dfe3ea",
      accent: "#e4572e"
    }),
    [isDark]
  );

  const currentWord = words[currentWordIndex] || "";
  const { before, focus, after } = splitWordForHighlight(currentWord);

  const resetReader = () => {
    setIsPlaying(false);
    clearInterval(intervalRef.current);
    intervalRef.current = null;
    setCurrentWordIndex(0);
  };

  useEffect(
    () => () => {
      clearInterval(intervalRef.current);
    },
    []
  );

  const startReading = (overrideWpm) => {
    if (!words.length) return;
    if (adBreakActive) return;
    const speed = clampWpm(overrideWpm ?? wpm);
    const intervalMs = Math.round(60000 / speed);
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setCurrentWordIndex((prev) => {
        const next = prev + 1;
        if (next >= words.length) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
          setIsPlaying(false);
          return prev;
        }
        if (!isPro && next > 0 && next % AD_FREQUENCY_WORDS === 0) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
          setIsPlaying(false);
          setAdBreakActive(true);
          return next;
        }
        return next;
      });
    }, intervalMs);
    setIsPlaying(true);
  };

  const toggleReading = () => {
    if (isPlaying) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      setIsPlaying(false);
      return;
    }
    startReading();
  };

  const handleReaderTap = () => {
    if (!hasTappedReader) {
      setHasTappedReader(true);
      Animated.timing(tapHintOpacity, {
        toValue: 0,
        duration: 500,
        useNativeDriver: true
      }).start();
    }
    toggleReading();
  };

  useEffect(() => {
    if (Platform.OS !== "ios") return undefined;
    let isMounted = true;

    const initIap = async () => {
      try {
        const connected = await RNIap.initConnection();
        if (!connected) return;
        const products = await RNIap.getSubscriptions({
          skus: Object.values(IAP_SKUS)
        });
        if (isMounted) {
          const map = {};
          products.forEach((product) => {
            map[product.productId] = product;
          });
          setIapProducts(map);
          setIapReady(true);
        }
      } catch (error) {
        if (isMounted) {
          setIapReady(false);
        }
      }
    };

    initIap();

    purchaseUpdateSubRef.current = RNIap.purchaseUpdatedListener(async (purchase) => {
      try {
        await RNIap.finishTransaction({ purchase, isConsumable: false });
        setIsPro(true);
        setAdBreakActive(false);
        setScreen("home");
      } catch (error) {
        setErrorMessage("Purchase failed to finalize.");
      }
    });

    purchaseErrorSubRef.current = RNIap.purchaseErrorListener(() => {
      setErrorMessage("Purchase cancelled or failed.");
    });

    return () => {
      isMounted = false;
      purchaseUpdateSubRef.current?.remove();
      purchaseErrorSubRef.current?.remove();
      RNIap.endConnection();
    };
  }, []);

  useEffect(() => {
    if (screen !== "text") return undefined;
    if (pdfPages.length) {
      return undefined;
    }
    const wordsLength = words.length;
    const isNewText = wordsLength !== lastWordsLengthRef.current;
    const initialCount = Math.min(
      isNewText ? INITIAL_FULL_TEXT_WORDS : fullTextCount,
      wordsLength
    );
    if (isNewText) {
      lastWordsLengthRef.current = wordsLength;
      setFullTextPage(0);
      setFullTextCount(initialCount);
    }
    let cancelled = false;
    let currentCount = initialCount;

    const loadMore = () => {
      if (cancelled || currentCount >= wordsLength) return;
      currentCount = Math.min(currentCount + FULL_TEXT_WORD_CHUNK, wordsLength);
      setFullTextCount(currentCount);
      if (currentCount < wordsLength) {
        setTimeout(loadMore, FULL_TEXT_CHUNK_DELAY);
      }
    };

    if (currentCount < wordsLength) {
      setTimeout(loadMore, FULL_TEXT_CHUNK_DELAY);
    }

    return () => {
      cancelled = true;
    };
  }, [screen, words.length, fullTextCount, pdfPages.length]);

  const handleStartReader = () => {
    if (!words.length) return;
    setScreen("reader");
    setIsPlaying(false);
    clearInterval(intervalRef.current);
    intervalRef.current = null;
  };

  const handleBackToHome = () => {
    setIsPlaying(false);
    clearInterval(intervalRef.current);
    intervalRef.current = null;
    setScreen("home");
  };

  const handleOpenTextView = () => {
    if (!words.length) return;
    setSelectedWordIndex(currentWordIndex);
    setScreen("text");
  };

  const handleStartFromSelection = () => {
    setCurrentWordIndex(selectedWordIndex);
    setScreen("reader");
  };

  const handleTextChange = (value) => {
    const nextWords = extractWords(value);
    if (nextWords.length > maxWords) {
      setErrorMessage(`Max ${maxWords.toLocaleString()} words allowed.`);
    } else {
      setErrorMessage("");
    }
    setReaderText(value);
    setCurrentWordIndex(0);
    setIsPlaying(false);
    clearInterval(intervalRef.current);
    intervalRef.current = null;
  };

  const handlePickPdf = async () => {
    setErrorMessage("");
    if (!pdfHtmlUri) {
      setErrorMessage(pdfEngineError || "PDF engine is still loading.");
      return;
    }
    try {
    if (!isPro && uploadedFiles.length >= FREE_LIBRARY_LIMIT) {
      setErrorMessage("Free plan allows up to 3 PDFs. Go Pro for unlimited.");
      setScreen("paywall");
      return;
    }
      const result = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        copyToCacheDirectory: true
      });
      if (result.canceled || !result.assets?.length) {
        return;
      }
      const asset = result.assets[0];
      if (asset.size && asset.size > MAX_PDF_BYTES) {
        setErrorMessage("PDF too large. Max 12 MB for now.");
        return;
      }
      const base64 = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: "base64"
      });
      setPdfFileName(asset.name || "PDF file");
      lastUploadRef.current = {
        name: asset.name || "PDF file",
        uri: asset.uri
      };
      setUploadedFiles((prev) => {
        const name = asset.name || "PDF file";
        const exists = prev.some((file) => file.name === name && file.uri === asset.uri);
        if (exists) {
          return prev;
        }
        return [...prev, { name, uri: asset.uri, size: asset.size || 0 }];
      });
      setPdfText("");
      setPdfPages([]);
      setPdfBase64(base64);
      setIsExtracting(true);
    } catch (error) {
      setErrorMessage(error?.message || String(error) || "Could not load that PDF.");
      setIsExtracting(false);
    }
  };

  const handleLoadPdfFromLibrary = async (file) => {
    setErrorMessage("");
    if (!pdfHtmlUri) {
      setErrorMessage(pdfEngineError || "PDF engine is still loading.");
      return;
    }
    try {
      if (file.size && file.size > MAX_PDF_BYTES) {
        setErrorMessage("PDF too large. Max 12 MB for now.");
        return;
      }
      const base64 = await FileSystem.readAsStringAsync(file.uri, {
        encoding: "base64"
      });
      setPdfFileName(file.name || "PDF file");
      setPdfText("");
      setPdfPages([]);
      setPdfBase64(base64);
      setIsExtracting(true);
      setTab("home");
    } catch (error) {
      setErrorMessage(error?.message || String(error) || "Could not load that PDF.");
      setIsExtracting(false);
    }
  };

  const getPlanProduct = (planKey) => iapProducts[IAP_SKUS[planKey]];

  const getPlanPrice = (planKey) =>
    getPlanProduct(planKey)?.localizedPrice || FALLBACK_PRICES[planKey];

  const handleUpgradeToPro = async () => {
    if (Platform.OS !== "ios") {
      setErrorMessage("Purchases are only supported on iOS right now.");
      return;
    }
    const sku = IAP_SKUS[selectedPlan];
    try {
      await RNIap.requestSubscription({ sku });
    } catch (error) {
      setErrorMessage("Unable to start purchase.");
    }
  };

  const handleRestorePurchases = async () => {
    if (Platform.OS !== "ios") return;
    try {
      const purchases = await RNIap.getAvailablePurchases();
      const hasActive = purchases.some((purchase) =>
        Object.values(IAP_SKUS).includes(purchase.productId)
      );
      if (hasActive) {
        setIsPro(true);
        setAdBreakActive(false);
        setScreen("home");
      } else {
        setErrorMessage("No active subscriptions found.");
      }
    } catch (error) {
      setErrorMessage("Restore failed.");
    }
  };

  useEffect(() => {
    if (!pdfBase64 || !webViewRef.current || !isWebViewReady) return;
    const total = Math.ceil(pdfBase64.length / PDF_CHUNK_SIZE);
    webViewRef.current.postMessage(JSON.stringify({ type: "pdf-reset" }));
    let index = 0;
    const sendNext = () => {
      const start = index * PDF_CHUNK_SIZE;
      const chunk = pdfBase64.slice(start, start + PDF_CHUNK_SIZE);
      webViewRef.current?.postMessage(
        JSON.stringify({
          type: "pdf-chunk",
          index,
          total,
          data: chunk
        })
      );
      index += 1;
      if (index < total) {
        setTimeout(sendNext, 0);
      }
    };
    sendNext();
  }, [pdfBase64, isWebViewReady]);

  useEffect(() => {
    if (!isExtracting) return;
    const timeoutId = setTimeout(() => {
      setIsExtracting(false);
      setErrorMessage("PDF extraction timed out. Try a smaller PDF.");
    }, 25000);
    return () => clearTimeout(timeoutId);
  }, [isExtracting]);

  useEffect(() => {
    let isActive = true;
    const loadPdfEngine = async () => {
      try {
        const dir = `${FileSystem.cacheDirectory}pdfjs/`;
        const pdfPath = `${dir}pdf.min.js`;
        const workerPath = `${dir}pdf.worker.min.js`;
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
        const pdfInfo = await FileSystem.getInfoAsync(pdfPath);
        const workerInfo = await FileSystem.getInfoAsync(workerPath);
        if (!pdfInfo.exists) {
          await FileSystem.downloadAsync(PDF_JS_URL, pdfPath);
        }
        if (!workerInfo.exists) {
          await FileSystem.downloadAsync(PDF_WORKER_URL, workerPath);
        }

        const htmlPath = `${dir}pdf-extractor.html`;
        const htmlContent = buildPdfExtractorHtml(pdfPath, workerPath);
        await FileSystem.writeAsStringAsync(htmlPath, htmlContent, { encoding: "utf8" });
        if (isActive) {
          setIsWebViewReady(false);
          setPdfHtmlUri(htmlPath);
          setPdfEngineError("");
        }
      } catch (error) {
        if (isActive) {
          setPdfHtmlUri("");
          setPdfEngineError(
            "PDF engine failed to load. Check your internet and try again."
          );
        }
      }
    };
    loadPdfEngine();
    return () => {
      isActive = false;
    };
  }, []);

  const handleWpmChange = (value) => {
    setWpmInput(value);
    const parsed = Number.parseInt(value, 10);
    const nextWpm = clampWpm(parsed);
    setWpm(nextWpm);
    if (isPlaying) {
      startReading(nextWpm);
    }
  };

  const openWpmModal = () => {
    setIsWpmModalVisible(true);
  };

  const closeWpmModal = () => {
    setIsWpmModalVisible(false);
  };

  const handlePdfMessage = (event) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data);
      if (payload.type === "ready") {
        setIsWebViewReady(true);
        return;
      }
      if (payload.type === "success") {
        setPdfText(payload.text || "");
        setPdfPages(Array.isArray(payload.pages) ? payload.pages : []);
        const totalExtractedWords = extractWords(payload.text || "").length;
        if (!isPro && totalExtractedWords > FREE_WORD_LIMIT) {
          setErrorMessage("Free plan allows up to 10,000 words. Go Pro for more.");
          if (lastUploadRef.current) {
            const { name, uri } = lastUploadRef.current;
            setUploadedFiles((prev) =>
              prev.filter((file) => !(file.name === name && file.uri === uri))
            );
            lastUploadRef.current = null;
          }
          setScreen("paywall");
          setPdfText("");
          setPdfPages([]);
          setIsExtracting(false);
          return;
        }
        setIsExtracting(false);
        setCurrentWordIndex(0);
        setIsPlaying(false);
        return;
      }
      if (payload.type === "error") {
        setErrorMessage(payload.message || "Could not read that PDF.");
      }
    } catch (error) {
      setErrorMessage("Could not read that PDF.");
    } finally {
      setIsExtracting(false);
    }
  };

  const pdfWebView = pdfHtmlUri ? (
    <WebView
      ref={webViewRef}
      source={{ uri: pdfHtmlUri }}
      allowingReadAccessToURL={pdfReadAccessUri}
      onMessage={handlePdfMessage}
      onLoadEnd={() => setIsWebViewReady(true)}
      originWhitelist={["*"]}
      allowFileAccessFromFileURLs
      allowUniversalAccessFromFileURLs
      pointerEvents="none"
      style={styles.hiddenWebView}
    />
  ) : null;

  if (screen === "reader") {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <StatusBar hidden />
        <View
          style={[styles.readerScreen, { width: screenWidth, height: screenHeight }]}
          pointerEvents="box-none"
        >
          <View style={styles.readerDisplay} pointerEvents="none">
            <View
              style={[
                styles.readerWordWrapper,
                {
                  top: screenHeight / 2,
                  transform: [{ translateY: -wordHeight / 2 }]
                }
              ]}
            >
              <Text
                style={[styles.readerTextLarge, { color: theme.text }]}
                onLayout={(event) => {
                  const nextHeight = Math.round(event.nativeEvent.layout.height);
                  if (nextHeight && nextHeight !== wordHeight) {
                    setWordHeight(nextHeight);
                  }
                }}
              >
                {before}
                <Text style={{ color: theme.accent }}>{focus || " "}</Text>
                {after}
              </Text>
            </View>
          </View>
          <Text
            pointerEvents="none"
            style={[
              styles.readerCount,
              {
                color: theme.subtleText,
                top: screenHeight / 2,
                transform: [{ translateY: wordHeight / 2 + 12 }]
              }
            ]}
          >
            {totalWordCount
              ? `Word ${Math.min(currentWordIndex + 1, totalWordCount)} of ${totalWordCount}`
              : "Add some text to start reading."}
          </Text>
          <Animated.Text
            pointerEvents="none"
            style={[
              styles.readerHint,
              {
                color: theme.subtleText,
                top: screenHeight / 2,
                opacity: tapHintOpacity,
                transform: [{ translateY: wordHeight / 2 + 34 }]
              }
            ]}
          >
            Tap to play/pause
          </Animated.Text>
          <Pressable style={styles.readerTapZone} onPress={handleReaderTap} />
          <View style={[styles.readerFooter, { borderColor: theme.border }]}>
            <Pressable
              style={[styles.footerButton, { borderColor: theme.border }]}
              onPress={resetReader}
              disabled={!words.length}
            >
              <Text style={[styles.buttonText, { color: theme.text }]}>Reset</Text>
            </Pressable>
            <Pressable
              style={[styles.footerButton, { borderColor: theme.border }]}
              onPress={handleOpenTextView}
              disabled={!words.length}
            >
              <Text style={[styles.buttonText, { color: theme.text }]}>Full Text</Text>
            </Pressable>
            <Pressable
              style={[styles.footerButton, { borderColor: theme.border }]}
              onPress={handleBackToHome}
            >
              <Text style={[styles.buttonText, { color: theme.text }]}>Main Menu</Text>
            </Pressable>
          </View>
          {!isPro && adBreakActive ? (
            <View style={[styles.adOverlay, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Ad break</Text>
              <Text style={[styles.sectionText, { color: theme.subtleText }]}>
                Free plan shows ads every 3,000 words.
              </Text>
              <Pressable
                style={[styles.footerButton, { borderColor: theme.border }]}
                onPress={() => setAdBreakActive(false)}
              >
                <Text style={[styles.buttonText, { color: theme.text }]}>Continue</Text>
              </Pressable>
              <Pressable
                style={[styles.footerButton, { borderColor: theme.border }]}
                onPress={() => setScreen("paywall")}
              >
                <Text style={[styles.buttonText, { color: theme.text }]}>Go Pro</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
        {pdfWebView ? <View pointerEvents="none">{pdfWebView}</View> : null}
      </View>
    );
  }

  if (screen === "text") {
    const usingPdfPages = pdfPagesWords.length > 0;
    const pageStart = usingPdfPages ? 0 : fullTextPage * WORDS_PER_PAGE;
    const maxLoaded = Math.min(fullTextCount, words.length);
    const pageEnd = usingPdfPages
      ? pdfPagesWords[fullTextPage]?.length || 0
      : Math.min(pageStart + WORDS_PER_PAGE, maxLoaded);
    const visibleWords = usingPdfPages
      ? pdfPagesWords[fullTextPage] || []
      : words.slice(pageStart, pageEnd);
    const totalPages = usingPdfPages
      ? pdfPagesWords.length
      : Math.max(1, Math.ceil(maxLoaded / WORDS_PER_PAGE));
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <StatusBar style={isDark ? "light" : "dark"} />
        <View style={styles.textScreen}>
          <View style={styles.textHeader}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Full Text</Text>
            <Text style={[styles.sectionText, { color: theme.subtleText }]}>
              Tap a word to choose where to start.
            </Text>
          </View>
          <View style={[styles.textContent, { paddingBottom: textFooterHeight }]}>
            <ScrollView
              contentContainerStyle={styles.textBody}
              style={styles.textScroll}
              keyboardShouldPersistTaps="handled"
              pointerEvents="auto"
            >
              {visibleWords.map((word, index) => {
                const absoluteIndex = usingPdfPages
                  ? (pdfPageOffsets[fullTextPage] || 0) + index
                  : pageStart + index;
                const isSelected = absoluteIndex === selectedWordIndex;
                return (
                  <Pressable
                    key={`${word}-${absoluteIndex}`}
                    onPress={() => setSelectedWordIndex(absoluteIndex)}
                    style={[
                      styles.wordToken,
                      isSelected && styles.wordTokenSelected,
                      { borderColor: theme.border }
                    ]}
                  >
                    <Text
                      style={[
                        styles.wordTokenText,
                        { color: isSelected ? theme.accent : theme.text }
                      ]}
                    >
                      {word}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
          <View
            style={[styles.textFooter, { borderColor: theme.border }]}
            pointerEvents="box-none"
            onLayout={(event) => {
              const nextHeight = Math.round(event.nativeEvent.layout.height);
              if (nextHeight && nextHeight !== textFooterHeight) {
                setTextFooterHeight(nextHeight);
              }
            }}
          >
            <Pressable
              style={[styles.footerButton, { borderColor: theme.border }]}
              onPress={handleStartFromSelection}
              disabled={!words.length}
              pointerEvents="auto"
            >
              <Text style={[styles.buttonText, { color: theme.text }]}>Start Here</Text>
            </Pressable>
            <Pressable
              style={[styles.pageButton, { borderColor: theme.border }]}
              onPress={() => setScreen("pages")}
              disabled={!words.length}
              pointerEvents="auto"
            >
              <Text style={[styles.buttonText, { color: theme.text }]}>
                Page {fullTextPage + 1}/{totalPages}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.footerButton, { borderColor: theme.border }]}
              onPress={() => setScreen("reader")}
              pointerEvents="auto"
            >
              <Text style={[styles.buttonText, { color: theme.text }]}>Back</Text>
            </Pressable>
          </View>
        </View>
        {pdfWebView ? <View pointerEvents="none">{pdfWebView}</View> : null}
      </View>
    );
  }

  if (screen === "pages") {
    const totalPagesAll = pdfPagesWords.length
      ? pdfPagesWords.length
      : Math.max(1, Math.ceil(words.length / WORDS_PER_PAGE));
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <StatusBar style={isDark ? "light" : "dark"} />
        <View style={styles.textScreen}>
          <View style={styles.textHeader}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Pages</Text>
            <Text style={[styles.sectionText, { color: theme.subtleText }]}>
              Choose a page to jump to.
            </Text>
          </View>
          <View style={[styles.textContent, { paddingBottom: textFooterHeight }]}>
            <ScrollView contentContainerStyle={styles.pageGrid}>
              {Array.from({ length: totalPagesAll }, (_, index) => {
                const isActive = index === fullTextPage;
                return (
                  <Pressable
                    key={`page-${index + 1}`}
                    onPress={() => {
                      if (pdfPagesWords.length) {
                        setFullTextPage(index);
                        setScreen("text");
                        return;
                      }
                      const neededCount = Math.min(
                        (index + 1) * WORDS_PER_PAGE,
                        words.length
                      );
                      if (neededCount > fullTextCount) {
                        setFullTextCount(neededCount);
                      }
                      setFullTextPage(index);
                      setScreen("text");
                    }}
                    style={[
                      styles.pageChip,
                      isActive && styles.pageChipActive,
                      { borderColor: theme.border }
                    ]}
                  >
                    <Text
                      style={[
                        styles.pageChipText,
                        { color: isActive ? theme.accent : theme.text }
                      ]}
                    >
                      {index + 1}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
          <View
            style={[styles.textFooter, { borderColor: theme.border }]}
            pointerEvents="box-none"
            onLayout={(event) => {
              const nextHeight = Math.round(event.nativeEvent.layout.height);
              if (nextHeight && nextHeight !== textFooterHeight) {
                setTextFooterHeight(nextHeight);
              }
            }}
          >
            <Pressable
              style={[styles.footerButton, { borderColor: theme.border }]}
              onPress={() => setScreen("text")}
              pointerEvents="auto"
            >
              <Text style={[styles.buttonText, { color: theme.text }]}>Back</Text>
            </Pressable>
          </View>
        </View>
        {pdfWebView ? <View pointerEvents="none">{pdfWebView}</View> : null}
      </View>
    );
  }

  if (screen === "paywall") {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <StatusBar style={isDark ? "light" : "dark"} />
        <ScrollView contentContainerStyle={styles.paywallScreen}>
          <View style={styles.paywallHeaderRow}>
            <Pressable
              onPress={() => setScreen("home")}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Text style={[styles.paywallClose, { color: theme.subtleText }]}>×</Text>
            </Pressable>
          </View>
          <Text style={[styles.paywallTitle, { color: theme.text }]}>
            Read faster with Pro.
          </Text>
          <Text style={[styles.sectionText, { color: theme.subtleText }]}>
            Unlock the full Reader experience with larger libraries and longer documents.
          </Text>

          <View style={styles.paywallBenefit}>
            <Text style={[styles.paywallBenefitTitle, { color: theme.text }]}>
              Unlimited PDFs
            </Text>
            <Text style={[styles.sectionText, { color: theme.subtleText }]}>
              Save every document without the free 3-file cap.
            </Text>
          </View>
          <View style={styles.paywallBenefit}>
            <Text style={[styles.paywallBenefitTitle, { color: theme.text }]}>
              50,000 word limit instead of 10,000
            </Text>
            <Text style={[styles.sectionText, { color: theme.subtleText }]}>
              Read long reports and books without truncation.
            </Text>
          </View>
          <View style={styles.paywallBenefit}>
            <Text style={[styles.paywallBenefitTitle, { color: theme.text }]}>
              Ad-free sessions
            </Text>
            <Text style={[styles.sectionText, { color: theme.subtleText }]}>
              No ad breaks interrupting your pace.
            </Text>
          </View>

          <View style={[styles.paywallPrimary, { borderColor: theme.border }]}>
            <Pressable
              style={[styles.paywallPrimaryButton, { borderColor: theme.border }]}
              onPress={() => setScreen("plans")}
            >
              <Text style={[styles.paywallPrimaryText, { color: theme.text }]}>
                Start free trial
              </Text>
            </Pressable>
            <Text style={[styles.paywallFinePrint, { color: theme.subtleText }]}>
              Cancel anytime. Billed monthly after trial.
            </Text>
            <Pressable onPress={handleRestorePurchases}>
              <Text style={[styles.paywallRestore, { color: theme.subtleText }]}>
                Restore purchases
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (screen === "plans") {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <StatusBar style={isDark ? "light" : "dark"} />
        <View style={styles.planOverlay}>
          <View style={[styles.planSheet, { borderColor: theme.border }]}>
            <View style={styles.planSheetHeader}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>
                Choose a plan
              </Text>
              <Pressable onPress={() => setScreen("paywall")}>
                <Text style={[styles.paywallClose, { color: theme.subtleText }]}>×</Text>
              </Pressable>
            </View>
            <Pressable
              style={[
                styles.planOption,
                { borderColor: theme.border },
                selectedPlan === "weekly" && styles.planOptionSelected
              ]}
              onPress={() => setSelectedPlan("weekly")}
            >
              <View>
                <Text style={[styles.planOptionTitle, { color: theme.text }]}>Weekly</Text>
                <Text style={[styles.sectionText, { color: theme.subtleText }]}>
                  Start at $2.98/week
                </Text>
              </View>
              <Text style={[styles.planOptionPrice, { color: theme.text }]}>
                {getPlanPrice("weekly")}
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.planOption,
                { borderColor: theme.border },
                selectedPlan === "monthly" && styles.planOptionSelected
              ]}
              onPress={() => setSelectedPlan("monthly")}
            >
              <View>
                <View style={styles.planOptionRow}>
                  <Text style={[styles.planOptionTitle, { color: theme.text }]}>Monthly</Text>
                  <Text style={[styles.planSaveBadge, { color: theme.text }]}>SAVE 25%</Text>
                </View>
                <Text style={[styles.sectionText, { color: theme.subtleText }]}>
                  25% off the weekly price
                </Text>
              </View>
              <Text style={[styles.planOptionPrice, { color: theme.text }]}>
                {getPlanPrice("monthly")}
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.planOption,
                { borderColor: theme.border },
                selectedPlan === "yearly" && styles.planOptionSelected
              ]}
              onPress={() => setSelectedPlan("yearly")}
            >
              <View>
                <View style={styles.planOptionRow}>
                  <Text style={[styles.planOptionTitle, { color: theme.text }]}>Yearly</Text>
                  <Text style={[styles.planSaveBadge, { color: theme.text }]}>SAVE 80%</Text>
                </View>
                <Text style={[styles.sectionText, { color: theme.subtleText }]}>
                  80% off the weekly price
                </Text>
              </View>
              <Text style={[styles.planOptionPrice, { color: theme.text }]}>
                {getPlanPrice("yearly")}
              </Text>
            </Pressable>

            <Pressable
              style={[styles.planConfirmButton, { borderColor: theme.border }]}
              onPress={handleUpgradeToPro}
            >
              <Text style={[styles.paywallPrimaryText, { color: theme.text }]}>
                Confirm and start trial
              </Text>
            </Pressable>
            <Text style={[styles.paywallFinePrint, { color: theme.subtleText }]}>
              Cancel anytime. Billed after trial ends.
            </Text>
            <Pressable onPress={handleRestorePurchases}>
              <Text style={[styles.paywallRestore, { color: theme.subtleText }]}>
                Restore purchases
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  const renderLibrary = () => (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Library</Text>
        <Text style={[styles.sectionText, { color: theme.subtleText }]}>
          Uploaded PDFs appear here.
        </Text>
        {uploadedFiles.length ? (
          uploadedFiles.map((file) => (
            <Pressable
              key={`${file.name}-${file.uri}`}
              onPress={() => handleLoadPdfFromLibrary(file)}
              style={[styles.libraryRow, { borderColor: theme.border }]}
            >
              <Text style={[styles.libraryItem, { color: theme.text }]}>
                {file.name}
              </Text>
              <Text style={[styles.libraryAction, { color: theme.subtleText }]}>
                Load
              </Text>
            </Pressable>
          ))
        ) : (
          <Text style={[styles.sectionText, { color: theme.subtleText }]}>
            No files yet.
          </Text>
        )}
      </View>
    </ScrollView>
  );

  const renderHome = () => (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <View style={styles.planRow}>
          <View style={styles.planTitleRow}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Plan</Text>
            <Text style={[styles.planStatusDot, { color: theme.subtleText }]}>•</Text>
            <Text style={[styles.planStatusText, { color: theme.subtleText }]}>
              {isPro ? "Pro" : "Free"}
            </Text>
          </View>
          {!isPro ? (
            <Pressable
              style={[styles.planButton, { borderColor: theme.border }]}
              onPress={() => setScreen("paywall")}
            >
              <Text style={[styles.planButtonText, { color: theme.text }]}>
                Go Pro
              </Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Sample Text</Text>
        <Text style={[styles.sectionText, { color: theme.subtleText }]}>
          Edit the text below to test the word-by-word reader.
        </Text>
        {pdfEngineError ? (
          <Text style={[styles.errorText, { color: theme.accent }]}>
            {pdfEngineError}
          </Text>
        ) : null}
        {pdfText ? (
          <Text style={[styles.sectionText, { color: theme.subtleText }]}>
            Using PDF: {pdfFileName || "Uploaded file"}
          </Text>
        ) : null}
        {errorMessage ? (
          <Text style={[styles.errorText, { color: theme.accent }]}>
            {errorMessage}
          </Text>
        ) : null}
        {isExtracting ? (
          <Text style={[styles.sectionText, { color: theme.subtleText }]}>
            Extracting PDF text...
          </Text>
        ) : null}
        <TextInput
          style={[
            styles.textArea,
            { color: theme.text, borderColor: theme.border }
          ]}
          value={readerText}
          onChangeText={handleTextChange}
          multiline
          textAlignVertical="top"
        />
      </View>

      <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Speed Reader</Text>
        <View style={styles.controls}>
          <Pressable
            style={[styles.button, { borderColor: theme.border }]}
            onPress={handleStartReader}
            disabled={!words.length}
          >
            <Text style={[styles.buttonText, { color: theme.text }]}>Start</Text>
          </Pressable>
          <Pressable
            style={[styles.button, { borderColor: theme.border }]}
            onPress={handlePickPdf}
          >
            <Text style={[styles.buttonText, { color: theme.text }]}>Upload File</Text>
          </Pressable>
        </View>
        <View style={styles.wpmRow}>
          <Text style={[styles.wpmLabel, { color: theme.subtleText }]}>WPM</Text>
          <Pressable
            style={[styles.wpmButton, { borderColor: theme.border }]}
            onPress={openWpmModal}
          >
            <Text style={[styles.wpmButtonText, { color: theme.text }]}>{wpm}</Text>
          </Pressable>
        </View>
        <Text style={[styles.sectionText, { color: theme.subtleText }]}>
          {totalWordCount ? `Total words: ${totalWordCount}` : "Total words: 0"}
        </Text>
      </View>
    </ScrollView>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <StatusBar style={isDark ? "light" : "dark"} />
      <View style={[styles.header, { borderColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]}>Reader</Text>
        <View style={styles.modeToggle}>
          <Text style={[styles.modeLabel, { color: theme.subtleText }]}>Dark</Text>
          <Switch value={isDark} onValueChange={setIsDark} />
        </View>
      </View>

      {tab === "home" ? renderHome() : renderLibrary()}
      {pdfWebView}
      {isWpmModalVisible ? (
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Set WPM</Text>
            <Text style={[styles.sectionText, { color: theme.subtleText }]}>
              Enter a value between {MIN_WPM} and {MAX_WPM}.
            </Text>
            <TextInput
              style={[
                styles.wpmInput,
                { color: theme.text, borderColor: theme.border }
              ]}
              value={wpmInput}
              onChangeText={handleWpmChange}
              keyboardType="number-pad"
            />
            <View style={styles.modalActions}>
              <Pressable
                style={[styles.footerButton, { borderColor: theme.border }]}
                onPress={closeWpmModal}
              >
                <Text style={[styles.buttonText, { color: theme.text }]}>Back</Text>
              </Pressable>
              <Pressable
                style={[styles.footerButton, { borderColor: theme.border }]}
                onPress={closeWpmModal}
              >
                <Text style={[styles.buttonText, { color: theme.text }]}>Set</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
      <View style={[styles.tabBar, { borderColor: theme.border }]}>
        <Pressable
          style={[styles.tabButton, tab === "home" && styles.tabButtonActive]}
          onPress={() => setTab("home")}
        >
          <Text style={[styles.tabText, { color: theme.text }]}>Main Menu</Text>
        </Pressable>
        <Pressable
          style={[styles.tabButton, tab === "library" && styles.tabButtonActive]}
          onPress={() => setTab("library")}
        >
          <Text style={[styles.tabText, { color: theme.text }]}>Library</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  title: {
    fontSize: 22,
    fontWeight: "600"
  },
  modeToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  modeLabel: {
    fontSize: 14
  },
  scrollContent: {
    padding: 20,
    gap: 16
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 12
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "600"
  },
  sectionText: {
    fontSize: 14,
    lineHeight: 20
  },
  libraryItem: {
    fontSize: 14,
    paddingVertical: 6
  },
  libraryRow: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  libraryAction: {
    fontSize: 12,
    fontWeight: "600"
  },
  planRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  planTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  planStatusDot: {
    fontSize: 14,
    fontWeight: "600"
  },
  planStatusText: {
    fontSize: 16,
    fontWeight: "600"
  },
  planButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  planButtonText: {
    fontSize: 12,
    fontWeight: "600"
  },
  errorText: {
    fontSize: 13
  },
  button: {
    alignSelf: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1
  },
  buttonText: {
    fontWeight: "600",
    fontSize: 13,
    letterSpacing: 0.2
  },
  paywallScreen: {
    padding: 24,
    gap: 16
  },
  paywallHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 16
  },
  paywallClose: {
    fontSize: 26,
    lineHeight: 26
  },
  paywallTitle: {
    fontSize: 24,
    fontWeight: "700",
    paddingTop: 50
  },
  paywallBenefit: {
    gap: 4
  },
  paywallBenefitTitle: {
    fontSize: 16,
    fontWeight: "600"
  },
  paywallPrimary: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    gap: 8
  },
  paywallPrimaryButton: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center"
  },
  paywallPrimaryText: {
    fontWeight: "700"
  },
  paywallFinePrint: {
    fontSize: 12,
    textAlign: "center"
  },
  paywallRestore: {
    fontSize: 12,
    textAlign: "center",
    textDecorationLine: "underline"
  },
  planOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    padding: 20
  },
  planSheet: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    gap: 12
  },
  planSheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  planOption: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  planOptionSelected: {
    borderWidth: 2
  },
  planOptionTitle: {
    fontSize: 14,
    fontWeight: "600"
  },
  planOptionPrice: {
    fontSize: 16,
    fontWeight: "700"
  },
  planOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  planSaveBadge: {
    fontSize: 10,
    fontWeight: "700"
  },
  planConfirmButton: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center"
  },
  hiddenWebView: {
    width: 0,
    height: 0,
    opacity: 0
  },
  tabBar: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12
  },
  tabButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1
  },
  tabButtonActive: {
    borderWidth: 2
  },
  tabText: {
    fontWeight: "600"
  },
  textArea: {
    minHeight: 140,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    lineHeight: 20
  },
  readerBox: {
    minHeight: 84,
    alignItems: "center",
    justifyContent: "center"
  },
  readerText: {
    fontSize: 32,
    fontWeight: "600",
    letterSpacing: 0.5
  },
  readerScreen: {
    position: "absolute",
    top: 0,
    left: 0
  },
  readerDisplay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    zIndex: 1
  },
  readerWordWrapper: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center"
  },
  readerTextLarge: {
    fontSize: 44,
    fontWeight: "700",
    letterSpacing: 0.6,
    lineHeight: 48,
    textAlign: "center"
  },
  readerCount: {
    position: "absolute",
    left: 0,
    right: 0,
    textAlign: "center"
  },
  readerHint: {
    position: "absolute",
    left: 0,
    right: 0,
    textAlign: "center",
    fontSize: 12
  },
  adOverlay: {
    position: "absolute",
    left: 24,
    right: 24,
    top: "40%",
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 10,
    zIndex: 20
  },
  readerTapZone: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2
  },
  textScreen: {
    flex: 1,
    paddingHorizontal: 20
  },
  textHeader: {
    paddingTop: 70,
    paddingBottom: 16,
    gap: 6
  },
  textBody: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingBottom: 0
  },
  textScroll: {
    flex: 1
  },
  textContent: {
    flex: 1
  },
  wordToken: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  wordTokenSelected: {
    borderWidth: 2
  },
  wordTokenText: {
    fontSize: 14,
    fontWeight: "500"
  },
  textFooter: {
    position: "absolute",
    left: 24,
    right: 24,
    bottom: 0,
    borderTopWidth: 1,
    paddingTop: 12,
    paddingBottom: 48,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    zIndex: 10,
    elevation: 10
  },
  pageButton: {
    flex: 1.2,
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 16,
    borderWidth: 1
  },
  pageGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    paddingBottom: 16
  },
  pageChip: {
    minWidth: 56,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center"
  },
  pageChipActive: {
    borderWidth: 2
  },
  pageChipText: {
    fontWeight: "600"
  },
  readerFooter: {
    position: "absolute",
    left: 24,
    right: 24,
    bottom: 0,
    borderTopWidth: 1,
    paddingTop: 12,
    paddingBottom: 48,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
    zIndex: 10
  },
  footerButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 16,
    borderWidth: 1
  },
  buttonText: {
    fontWeight: "600",
    fontSize: 13,
    letterSpacing: 0.2
  },
  controls: {
    flexDirection: "row",
    gap: 12
  },
  wpmRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  wpmLabel: {
    fontSize: 14
  },
  wpmButton: {
    minWidth: 72,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: "center"
  },
  wpmButtonText: {
    fontSize: 14,
    fontWeight: "600"
  },
  wpmInput: {
    minWidth: 72,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    textAlign: "center"
  },
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    padding: 24
  },
  modalCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 12
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12
  }
});
