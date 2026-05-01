import { useReducer } from "react"
 
import "./style.css"
 
function IndexPopup() {
  const [count, increase] = useReducer((c) => c + 1, 0)
 
  return (
    <div className="w-96 h-72 flex flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-bold">Hello World</h1>
      <p className="text-gray-500">Count: {count}</p>
      <button
        className="px-4 py-2 bg-blue-500 text-white rounded"
        onClick={increase}
      >
        Increase
      </button>
    </div>
  )
}
 
export default IndexPopup