import mongoose from 'mongoose'

const connectDB = async () => {
  mongoose.connection.on('connected', () => {
    console.log('MongoDB connected')
  })

  mongoose.connection.on('error', (err) => {
    console.error('MongoDB error:', err)
  })

  mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB disconnected')
  })

  await mongoose.connect(process.env.MONGO_URI, {
    maxPoolSize: 10, // tune later
  })
}

export default connectDB